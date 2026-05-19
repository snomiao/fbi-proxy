import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";
import yargs from "yargs";
import { getFbiProxyBinary } from "./buildFbiProxy";

const ANCHOR_NAME = "com.snomiao.fbi-proxy";
const ANCHOR_FILE = `/etc/pf.anchors/${ANCHOR_NAME}`;
const PF_PLIST = `/Library/LaunchDaemons/${ANCHOR_NAME}-pf.plist`;
const PF_CONF = "/etc/pf.conf";
const PF_CONF_MARKER_BEGIN = `# >>> ${ANCHOR_NAME} (managed by fbi-proxy setup) >>>`;
const PF_CONF_MARKER_END = `# <<< ${ANCHOR_NAME} <<<`;
const OXMGR_NAME = "fbi-proxy";

export interface SetupContext {
  originalCwd: string;
}

export async function runSetup(
  args: string[],
  ctx: SetupContext,
): Promise<void> {
  if (process.platform !== "darwin") {
    console.error(
      "[setup] macOS only. On other OSes run `fbi-proxy --tls --domain <x>` directly.",
    );
    process.exit(2);
  }

  const argv = await yargs(args)
    .scriptName("fbi-proxy setup")
    .usage(
      "$0 [options]\n\nConfigure fbi-proxy so https://<domain>/ works naturally.",
    )
    .option("domain", { type: "string", default: "fbi.com" })
    .option("port", {
      type: "number",
      default: 8443,
      description: "Backend port (oxmgr-managed daemon)",
    })
    .option("public-port", {
      type: "number",
      default: 443,
      description: "Public port pf redirects from",
    })
    .option("uninstall", {
      type: "boolean",
      default: false,
      description: "Tear down everything this command set up",
    })
    .help().argv;

  if (argv.uninstall) return uninstall();

  const domain = argv.domain;
  const port = argv.port;
  const publicPort = argv["public-port"];

  console.log(
    `[setup] target: https://${domain}/  →  oxmgr proxy :${port}, pf :${publicPort}→:${port}`,
  );

  const binary = await getFbiProxyBinary({ originalCwd: ctx.originalCwd });
  const absBinary = path.isAbsolute(binary) ? binary : path.resolve(binary);
  console.log(`[setup] binary: ${absBinary}`);

  const home = process.env.HOME!;
  const certDir =
    process.env.FBI_PROXY_CERT_DIR ??
    path.join(home, ".config/fbi-proxy/certs");
  const certPath = path.join(certDir, `${domain}.pem`);

  // 1. Reinstall oxmgr daemon (idempotent — delete is best-effort)
  spawnSync("oxmgr", ["delete", OXMGR_NAME], { stdio: "ignore" });
  const startResult = spawnSync(
    "oxmgr",
    [
      "start",
      "--name",
      OXMGR_NAME,
      "--restart",
      "always",
      "--cwd",
      path.dirname(absBinary),
      "--env",
      `HOME=${home}`,
      "--env",
      `PATH=${process.env.PATH || "/usr/local/bin:/usr/bin:/bin"}`,
      "--env",
      `FBI_PROXY_CERT_DIR=${certDir}`,
      `${absBinary} --tls --domain ${domain} --port ${port}`,
    ],
    { stdio: "inherit" },
  );
  if (startResult.status !== 0) {
    console.error(
      "[setup] oxmgr start failed — is `oxmgr` installed? (`npm i -g oxmgr` or `brew install oxmgr`)",
    );
    process.exit(startResult.status ?? 1);
  }
  // Persist oxmgr across reboots (writes the LaunchAgent if not already)
  spawnSync("oxmgr", ["service", "install"], { stdio: "ignore" });

  // 2. Wait for daemon listen + cert generation
  process.stdout.write("[setup] waiting for daemon");
  let listening = false;
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    const probe = spawnSync(
      "sh",
      [
        "-c",
        `curl -sk --max-time 1 https://127.0.0.1:${port}/ -o /dev/null && echo ok`,
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    if (probe.stdout?.toString().includes("ok") && existsSync(certPath)) {
      listening = true;
      break;
    }
    process.stdout.write(".");
  }
  process.stdout.write("\n");
  if (!listening) {
    console.error(
      `[setup] daemon did not come up on :${port} — check \`oxmgr logs ${OXMGR_NAME}\``,
    );
    process.exit(1);
  }

  // 3. Single root batch for cert trust + pf forward (osascript GUI prompt)
  const certTrusted = isMacosCertTrusted(certPath);
  const pfActive = isPfRuleActive(publicPort, port);
  if (certTrusted && pfActive) {
    console.log("[setup] cert already trusted, pf forward already active");
  } else {
    const todo = [
      !certTrusted && "install cert to system trust",
      !pfActive && `install pf forward :${publicPort}→:${port}`,
    ]
      .filter(Boolean)
      .join(" + ");
    console.log(`[setup] root needs to: ${todo}`);
    const script = buildRootBatch({
      certTrusted,
      pfActive,
      certPath,
      publicPort,
      port,
    });
    if (!runAsRoot(script)) {
      console.error("[setup] root step failed (cert / pf install)");
      process.exit(1);
    }
  }

  // 4. DNS check (warn, don't fix — /etc/hosts vs dnsmasq vs resolver is local choice)
  if (!resolvesToLoopback(domain)) {
    console.log(`[setup] WARNING: ${domain} does not resolve to 127.0.0.1.`);
    console.log(
      "  Quickfix:  echo '127.0.0.1 " + domain + "' | sudo tee -a /etc/hosts",
    );
  }

  // 5. End-to-end check
  const e2e = spawnSync(
    "sh",
    ["-c", `curl -sf --max-time 5 https://${domain}/ -o /dev/null && echo ok`],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  if (e2e.stdout?.toString().includes("ok")) {
    console.log(`[setup] ✓ https://${domain}/ reachable with trusted cert`);
  } else {
    console.log(
      `[setup] daemon up on :${port}, cert trusted, pf rule installed.`,
    );
    console.log(
      `[setup] https://${domain}/ end-to-end check failed — most likely DNS (see warning above).`,
    );
  }
}

async function uninstall(): Promise<void> {
  console.log("[setup] uninstalling fbi-proxy daemon + pf forward…");
  spawnSync("oxmgr", ["delete", OXMGR_NAME], { stdio: "inherit" });
  // sed deletes from BEGIN marker through END marker inclusive (BSD sed: -i ''
  // for in-place). pfctl reload picks up the change.
  const script = [
    `launchctl unload ${PF_PLIST} 2>/dev/null || true`,
    `rm -f ${PF_PLIST} ${ANCHOR_FILE}`,
    `/usr/bin/sed -i '' '/${escSed(PF_CONF_MARKER_BEGIN)}/,/${escSed(PF_CONF_MARKER_END)}/d' ${PF_CONF}`,
    `/sbin/pfctl -f ${PF_CONF} 2>/dev/null || true`,
    "echo uninstalled",
  ].join("\n");
  runAsRoot(script);
  console.log(
    "[setup] done. Cert remains trusted (remove via Keychain Access if desired).",
  );
}

function escSed(s: string): string {
  return s.replace(/[\\/.*[\]^$]/g, "\\$&");
}

function buildRootBatch(opts: {
  certTrusted: boolean;
  pfActive: boolean;
  certPath: string;
  publicPort: number;
  port: number;
}): string {
  const parts: string[] = [];
  if (!opts.certTrusted) {
    parts.push(
      `security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ${shellQuote(opts.certPath)}`,
    );
  }
  if (!opts.pfActive) {
    const anchorBody = `rdr pass on lo0 inet proto tcp from any to any port ${opts.publicPort} -> 127.0.0.1 port ${opts.port}\n`;
    const plistBody = pfLaunchDaemonPlist();
    parts.push(heredoc(ANCHOR_FILE, anchorBody));
    parts.push(`chmod 644 ${ANCHOR_FILE}`);
    parts.push(heredoc(PF_PLIST, plistBody));
    parts.push(`chown root:wheel ${PF_PLIST}`);
    parts.push(`chmod 644 ${PF_PLIST}`);
    // Reference our anchor from /etc/pf.conf — without this the rules in the
    // anchor file are dormant. pf is strict about ordering: translation
    // anchors (rdr-anchor) MUST appear before filtering anchors. Apple's
    // default pf.conf already has `rdr-anchor "com.apple/*"` followed later
    // by `anchor "com.apple/*"`, so we insert ours immediately after Apple's
    // rdr-anchor line. Always strip any prior fbi-proxy block first so a
    // re-run repairs a wrong-position entry from older setup versions.
    parts.push(
      `/usr/bin/sed -i '' '/^# >>> ${escSed(ANCHOR_NAME)}/,/^# <<< ${escSed(ANCHOR_NAME)}/d' ${PF_CONF}`,
    );
    parts.push(
      `cat > /tmp/fbi-proxy-pf.awk <<'__FBI_SETUP_EOF__'\n` +
        `/^rdr-anchor "com\\.apple/ && !done {\n` +
        `  print\n` +
        `  print "${PF_CONF_MARKER_BEGIN}"\n` +
        `  print "rdr-anchor \\"${ANCHOR_NAME}\\""\n` +
        `  print "load anchor \\"${ANCHOR_NAME}\\" from \\"${ANCHOR_FILE}\\""\n` +
        `  print "${PF_CONF_MARKER_END}"\n` +
        `  done = 1\n` +
        `  next\n` +
        `}\n` +
        `{ print }\n` +
        `__FBI_SETUP_EOF__`,
    );
    parts.push(
      `/usr/bin/awk -f /tmp/fbi-proxy-pf.awk ${PF_CONF} > /tmp/pf.conf.fbi-proxy.new`,
    );
    parts.push(`mv /tmp/pf.conf.fbi-proxy.new ${PF_CONF}`);
    parts.push(`rm -f /tmp/fbi-proxy-pf.awk`);
    // Sanity-check the new pf.conf before applying (dry-run parse). If it
    // fails, leave pf in its prior state rather than wiping the ruleset.
    parts.push(`/sbin/pfctl -nf ${PF_CONF}`);
    parts.push(`launchctl unload ${PF_PLIST} 2>/dev/null || true`);
    parts.push(`launchctl load -w ${PF_PLIST}`);
    // -E enables pf (idempotent, returns a token if it flips state), then
    // reload the main ruleset so our newly-added anchor reference is picked
    // up. The LaunchDaemon does the same at boot.
    parts.push(`/sbin/pfctl -E 2>/dev/null || true`);
    parts.push(`/sbin/pfctl -f ${PF_CONF}`);
  }
  parts.push("echo OK");
  return parts.join("\n");
}

function heredoc(filePath: string, body: string): string {
  // Single-quoted heredoc tag → body is literal (no shell expansion)
  return `cat > ${filePath} <<'__FBI_SETUP_EOF__'\n${body}__FBI_SETUP_EOF__`;
}

function pfLaunchDaemonPlist(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${ANCHOR_NAME}-pf</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>/sbin/pfctl -E 2>/dev/null; /sbin/pfctl -f ${PF_CONF}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>/var/log/${ANCHOR_NAME}-pf.out.log</string>
  <key>StandardErrorPath</key><string>/var/log/${ANCHOR_NAME}-pf.err.log</string>
</dict>
</plist>
`;
}

function isMacosCertTrusted(certPath: string): boolean {
  if (!existsSync(certPath)) return false;
  const result = spawnSync("security", ["verify-cert", "-c", certPath], {
    stdio: "ignore",
  });
  return result.status === 0;
}

function isPfRuleActive(from: number, to: number): boolean {
  if (!existsSync(ANCHOR_FILE) || !existsSync(PF_PLIST)) return false;
  let conf = "";
  try {
    conf = readFileSync(PF_CONF, "utf8");
  } catch {
    return false;
  }
  const markerIdx = conf.indexOf(PF_CONF_MARKER_BEGIN);
  if (markerIdx < 0) return false;
  // pf requires translation anchors (rdr-anchor) to precede filter anchors
  // (anchor). If our block was appended at the end of pf.conf (older setup
  // version, or hand-edit) it sits after `anchor "com.apple/*"` and the
  // entire ruleset fails to parse. Treat that as "not installed" so the
  // install path repairs it.
  // Match the filter anchor at line-start so we don't accidentally hit
  // `scrub-anchor "com.apple/*"` or `rdr-anchor "com.apple/*"` (substring of
  // which is `anchor "com.apple/*"`).
  const filterMatch = conf.match(/^anchor "com\.apple\/\*"$/m);
  const filterIdx = filterMatch?.index ?? -1;
  if (filterIdx >= 0 && markerIdx > filterIdx) return false;
  // Best-effort live-ruleset check; if sudo needs a password we trust the
  // on-disk state since the LaunchDaemon should have loaded it.
  const probe = spawnSync(
    "sudo",
    ["-n", "/sbin/pfctl", "-a", ANCHOR_NAME, "-s", "nat"],
    {
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  if (probe.status !== 0) return true;
  const out = probe.stdout?.toString() ?? "";
  return out.includes(`port = ${from}`) && out.includes(`port ${to}`);
}

function resolvesToLoopback(domain: string): boolean {
  const result = spawnSync("dig", ["+short", "+time=1", "+tries=1", domain], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  return (result.stdout?.toString() ?? "").trim().startsWith("127.0.0.1");
}

function runAsRoot(script: string): boolean {
  if (process.getuid?.() === 0) {
    return spawnSync("sh", ["-c", script], { stdio: "inherit" }).status === 0;
  }
  const hasTty = !!process.stdin.isTTY;
  if (hasTty) {
    console.log("[setup] (terminal sudo — enter password)");
    return (
      spawnSync("sudo", ["sh", "-c", script], { stdio: "inherit" }).status === 0
    );
  }
  console.log("[setup] (opening macOS auth dialog — enter password)");
  const wrapped = `do shell script ${appleScriptQuote(script)} with administrator privileges`;
  return (
    spawnSync("osascript", ["-e", wrapped], { stdio: "inherit" }).status === 0
  );
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function appleScriptQuote(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
