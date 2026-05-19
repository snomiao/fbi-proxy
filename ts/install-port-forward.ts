#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

const ANCHOR_NAME = "com.snomiao.fbi-proxy";
const ANCHOR_FILE = `/etc/pf.anchors/${ANCHOR_NAME}`;
const PLIST_FILE = `/Library/LaunchDaemons/${ANCHOR_NAME}-pf.plist`;

const argv = await yargs(hideBin(process.argv))
  .option("from", {
    type: "number",
    default: 443,
    description: "Public-facing port to redirect (privileged)",
  })
  .option("to", {
    type: "number",
    default: 8443,
    description: "Backend port the oxmgr-managed proxy listens on",
  })
  .option("uninstall", {
    type: "boolean",
    default: false,
    description: "Remove the pf rule and LaunchDaemon",
  })
  .help().argv;

if (process.platform !== "darwin") {
  console.error("install-port-forward: macOS only (pf rules)");
  process.exit(2);
}

if (argv.uninstall) {
  const script = [
    `launchctl unload "${PLIST_FILE}" 2>/dev/null`,
    `rm -f "${PLIST_FILE}" "${ANCHOR_FILE}"`,
    `pfctl -a ${ANCHOR_NAME} -F all 2>/dev/null`,
    "echo uninstalled",
  ].join("\n");
  runAsRoot(script);
  process.exit(0);
}

// pf-rdr is loopback-only here because fbi.com resolves to 127.0.0.1 via local
// DNS. If you ever expose this on a real interface, widen the rule.
const anchorContent = `rdr pass on lo0 inet proto tcp from any to any port ${argv.from} -> 127.0.0.1 port ${argv.to}\n`;

const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${ANCHOR_NAME}-pf</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>/sbin/pfctl -E 2>/dev/null; /sbin/pfctl -a ${ANCHOR_NAME} -f ${ANCHOR_FILE}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>/var/log/${ANCHOR_NAME}-pf.out.log</string>
  <key>StandardErrorPath</key><string>/var/log/${ANCHOR_NAME}-pf.err.log</string>
</dict>
</plist>
`;

if (alreadyInstalledFor(argv.from, argv.to)) {
  console.log(
    `pf forward :${argv.from} -> :${argv.to} already installed and active`,
  );
  process.exit(0);
}

console.log(
  `installing pf forward :${argv.from} -> :${argv.to} via macOS auth dialog…`,
);

// Single elevated shell — writes both files, loads the LaunchDaemon, and
// applies the rule immediately so we don't wait for a reboot.
const heredoc = (path: string, body: string) =>
  `cat > "${path}" <<'__FBI_PROXY_PF_EOF__'\n${body}__FBI_PROXY_PF_EOF__`;

const script = [
  heredoc(ANCHOR_FILE, anchorContent),
  `chmod 644 "${ANCHOR_FILE}"`,
  heredoc(PLIST_FILE, plistContent),
  `chown root:wheel "${PLIST_FILE}"`,
  `chmod 644 "${PLIST_FILE}"`,
  `launchctl unload "${PLIST_FILE}" 2>/dev/null || true`,
  `launchctl load -w "${PLIST_FILE}"`,
  `/sbin/pfctl -E 2>/dev/null || true`,
  `/sbin/pfctl -a ${ANCHOR_NAME} -f "${ANCHOR_FILE}"`,
  `echo OK`,
].join("\n");

const status = runAsRoot(script);
if (status !== 0) {
  console.error(`pf forward install failed (exit ${status})`);
  process.exit(1);
}

if (alreadyInstalledFor(argv.from, argv.to)) {
  console.log(
    `pf forward :${argv.from} -> :${argv.to} active. LaunchDaemon: ${PLIST_FILE}`,
  );
} else {
  console.warn(
    `pf forward installed but verification failed — check 'sudo pfctl -a ${ANCHOR_NAME} -s nat'`,
  );
}

function runAsRoot(script: string): number {
  const hasTty = !!process.stdin.isTTY;
  if (hasTty && process.getuid?.() !== 0) {
    const result = spawnSync("sudo", ["sh", "-c", script], {
      stdio: "inherit",
    });
    return result.status ?? 1;
  }
  if (process.getuid?.() === 0) {
    const result = spawnSync("sh", ["-c", script], { stdio: "inherit" });
    return result.status ?? 1;
  }
  // GUI password dialog — works without TTY (Claude Code, oxmgr children, etc.)
  const osascript = `do shell script ${appleScriptQuote(script)} with administrator privileges`;
  const result = spawnSync("osascript", ["-e", osascript], {
    stdio: "inherit",
  });
  return result.status ?? 1;
}

function alreadyInstalledFor(from: number, to: number): boolean {
  if (!existsSync(ANCHOR_FILE) || !existsSync(PLIST_FILE)) return false;
  // -s nat needs root to read the runtime rule table on most setups
  const probe = spawnSync(
    "sudo",
    ["-n", "/sbin/pfctl", "-a", ANCHOR_NAME, "-s", "nat"],
    {
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  if (probe.status !== 0) return false;
  const out = probe.stdout?.toString() ?? "";
  return out.includes(`port = ${from}`) && out.includes(`port ${to}`);
}

function appleScriptQuote(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
