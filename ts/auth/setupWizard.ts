import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { AuthConfigShape } from "./authConfig";
import { randomBytes } from "node:crypto";

export type WizardPrompter = {
  ask: (question: string, defaultValue?: string) => Promise<string>;
  askChoice: (question: string, choices: readonly string[]) => Promise<number>;
  print: (line: string) => void;
};

export type WizardOptions = {
  domain: string;
  existing?: AuthConfigShape | null;
};

export async function runWizard(
  prompter: WizardPrompter,
  opts: WizardOptions,
): Promise<AuthConfigShape> {
  prompter.print("");
  prompter.print("fbi-auth setup wizard");
  prompter.print("─────────────────────");
  prompter.print("");

  const domain = await prompter.ask("Domain to gate", opts.domain);
  const cleanDomain = domain.replace(/^\.+/, "").trim();

  const providerIdx = await prompter.askChoice("Identity provider", [
    "Google OAuth (BYO client ID + secret)",
    "Firebase Auth (BYO project ID)",
  ]);
  const provider: AuthConfigShape["provider"] =
    providerIdx === 0 ? "google" : "firebase";

  let clientId: string | undefined;
  let clientSecret: string | undefined;
  let firebase: AuthConfigShape["firebase"];

  if (provider === "google") {
    clientId = await prompter.ask(
      "Google OAuth Client ID",
      opts.existing?.provider === "google" ? opts.existing.clientId : undefined,
    );
    clientSecret = await prompter.ask(
      "Google OAuth Client Secret",
      opts.existing?.provider === "google"
        ? opts.existing.clientSecret
        : undefined,
    );
    prompter.print("");
    prompter.print(
      `  → Add this redirect URI in Google Cloud Console: https://sso.${cleanDomain}/callback`,
    );
    prompter.print("");
  } else {
    const projectId = await prompter.ask(
      "Firebase Project ID",
      opts.existing?.firebase?.projectId,
    );
    const apiKey = await prompter.ask(
      "Firebase Web API Key (optional)",
      opts.existing?.firebase?.apiKey ?? "",
    );
    const authDomain = await prompter.ask(
      "Firebase Auth Domain",
      opts.existing?.firebase?.authDomain ?? `${projectId}.firebaseapp.com`,
    );
    firebase = {
      projectId: projectId.trim(),
      apiKey: apiKey.trim() || undefined,
      authDomain: authDomain.trim() || undefined,
    };
  }

  const allowIdx = await prompter.askChoice("Allowlist policy", [
    "Anyone who completes sign-in",
    "Specific email addresses",
    "Specific email domain(s)",
  ]);

  let allowlist: AuthConfigShape["allowlist"] = { anySignedIn: true };
  if (allowIdx === 1) {
    const raw = await prompter.ask("Allowed emails (comma-separated)");
    allowlist = {
      emails: raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      anySignedIn: false,
    };
  } else if (allowIdx === 2) {
    const raw = await prompter.ask("Allowed email domains (comma-separated)");
    allowlist = {
      domains: raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      anySignedIn: false,
    };
  }

  const cfg: AuthConfigShape = {
    version: 1,
    domain: cleanDomain,
    cookieDomain: `.${cleanDomain}`,
    ssoHost: `sso.${cleanDomain}`,
    provider,
    clientId,
    clientSecret,
    firebase,
    sessionSecret:
      opts.existing?.sessionSecret ?? randomBytes(32).toString("base64url"),
    allowlist,
  };

  prompter.print("");
  prompter.print("Config preview:");
  prompter.print(JSON.stringify(redact(cfg), null, 2));
  prompter.print("");

  return cfg;
}

function redact(c: AuthConfigShape): AuthConfigShape {
  return {
    ...c,
    clientSecret: c.clientSecret ? "***" : undefined,
    sessionSecret: "***",
  };
}

export function readlinePrompter(): WizardPrompter {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  return {
    async ask(question, defaultValue) {
      const hint =
        defaultValue !== undefined && defaultValue !== ""
          ? ` [${defaultValue}]`
          : "";
      const answer = (await rl.question(`? ${question}${hint}: `)).trim();
      return answer || defaultValue || "";
    },
    async askChoice(question, choices) {
      this.print(`? ${question}:`);
      choices.forEach((c, i) => this.print(`    ${i + 1}) ${c}`));
      while (true) {
        const raw = (await rl.question("> ")).trim();
        const idx = Number(raw) - 1;
        if (Number.isInteger(idx) && idx >= 0 && idx < choices.length)
          return idx;
        this.print(`  (enter 1-${choices.length})`);
      }
    },
    print(line) {
      stdout.write(line + "\n");
    },
  };
}

export function isTty(): boolean {
  return Boolean(stdin.isTTY && stdout.isTTY);
}

export function closeReadlinePrompter(p: WizardPrompter): void {
  void p;
  // readline.createInterface keeps stdin in raw-ish mode; calling rl.close() requires the rl ref
  // — kept simple here since the wizard runs once at startup and we exit/proceed right after.
}
