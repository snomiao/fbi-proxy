/**
 * `fbi-proxy up | down | ps | config` — compose-style management of
 * runtime routing rules. Each project ships an `fbi-proxy.yaml` whose
 * top-level `name` is the namespace; rules are stored as conf.d
 * fragments and applied live via the loopback admin API.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import YAML from "yaml";
import { parseComposeYaml, validateRoute, type RouteConfig } from "./routes";
import {
  applyRules,
  deleteRules,
  listRules,
  type RuleInfo,
} from "./adminClient";

const DEFAULT_FILE = "fbi-proxy.yaml";

export const RULES_SUBCOMMANDS = new Set(["up", "down", "ps", "config"]);

/** Derive the namespace: explicit `-p` > compose `name` > directory name. */
function resolveNamespace(
  explicit: string | undefined,
  composeName: string | undefined,
  filePath: string,
): string {
  if (explicit) return explicit;
  if (composeName) return composeName;
  // directory of the compose file (or CWD for stdin) — like docker compose.
  return path.basename(path.dirname(path.resolve(filePath)));
}

function loadCompose(file: string): { name?: string; routes: RouteConfig[] } {
  if (!existsSync(file)) {
    throw new Error(
      `[fbi-proxy] ${file} not found. Create one (compose-style):\n` +
        `  name: my-app\n  routes:\n    - name: web\n      match: fbi.com\n      path: /\n      target: localhost:3000`,
    );
  }
  const compose = parseComposeYaml(readFileSync(file, "utf8"));
  for (const r of compose.routes) {
    const v = validateRoute(r);
    if (!v.valid) {
      throw new Error(`[fbi-proxy] ${file}: rule '${r.name}': ${v.reason}`);
    }
  }
  return compose;
}

function printRulesTable(rules: RuleInfo[]): void {
  if (rules.length === 0) {
    console.log("(no rules)");
    return;
  }
  const rows = rules.map((r) => ({
    NAMESPACE: r.namespace,
    NAME: r.name,
    MATCH: r.match,
    PATH: r.path ?? "*",
    TARGET: r.target,
  }));
  const cols = ["NAMESPACE", "NAME", "MATCH", "PATH", "TARGET"] as const;
  const widths = Object.fromEntries(
    cols.map((c) => [
      c,
      Math.max(c.length, ...rows.map((row) => String(row[c]).length)),
    ]),
  ) as Record<(typeof cols)[number], number>;
  const fmt = (row: Record<string, string>) =>
    cols.map((c) => String(row[c]).padEnd(widths[c])).join("  ");
  console.log(fmt(Object.fromEntries(cols.map((c) => [c, c]))));
  for (const row of rows) console.log(fmt(row));
}

/**
 * Entry point dispatched from cli.ts when the first positional arg is one
 * of `up|down|ps|config`. Returns the process exit code.
 */
export async function runRulesCli(rawArgs: string[]): Promise<number> {
  const argv = await yargs(rawArgs)
    .scriptName("fbi-proxy")
    .command("up", "Apply this project's fbi-proxy.yaml to the running proxy")
    .command("down", "Remove this project's rules from the running proxy")
    .command("ps", "List active rules across all namespaces")
    .command("config", "Print the merged resolved routing table")
    .option("file", {
      alias: "f",
      type: "string",
      default: DEFAULT_FILE,
      description: "Path to the compose file",
    })
    .option("project", {
      alias: "p",
      type: "string",
      description:
        "Override the namespace (defaults to compose `name` or dir name)",
    })
    .option("output", {
      alias: "o",
      type: "string",
      choices: ["table", "json", "yaml"] as const,
      default: "table",
      description: "Output format for ps/config",
    })
    .help().argv;

  const cmd = String(argv._[0]);

  try {
    switch (cmd) {
      case "up": {
        const compose = loadCompose(argv.file);
        const ns = resolveNamespace(argv.project, compose.name, argv.file);
        const body = YAML.stringify({ version: 1, routes: compose.routes });
        const applied = await applyRules(ns, body);
        console.log(
          `[fbi-proxy] up: namespace '${ns}' (${compose.routes.length} rule(s))`,
        );
        printRulesTable(applied.filter((r) => r.namespace === ns));
        return 0;
      }
      case "down": {
        // Namespace can come from -p, or the compose file if present.
        let ns = argv.project;
        if (!ns) {
          const compose = existsSync(argv.file) ? loadCompose(argv.file) : null;
          ns = resolveNamespace(undefined, compose?.name, argv.file);
        }
        const res = await deleteRules(ns);
        console.log(
          res.removed
            ? `[fbi-proxy] down: removed namespace '${ns}'`
            : `[fbi-proxy] down: namespace '${ns}' was not present`,
        );
        return 0;
      }
      case "ps":
      case "config": {
        const rules = await listRules();
        if (argv.output === "json") {
          console.log(JSON.stringify(rules, null, 2));
        } else if (argv.output === "yaml") {
          console.log(YAML.stringify(rules));
        } else {
          printRulesTable(rules);
        }
        return 0;
      }
      default:
        console.error(`[fbi-proxy] unknown command '${cmd}'`);
        return 2;
    }
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 1;
  }
}

/** Convenience for standalone invocation/testing. */
if (import.meta.main) {
  runRulesCli(hideBin(process.argv)).then((code) => process.exit(code));
}
