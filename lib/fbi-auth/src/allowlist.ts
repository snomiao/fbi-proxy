import type { AllowlistRules } from "./config";

export type AllowDecision = { allow: true } | { allow: false; reason: string };

export function decide(
  rules: AllowlistRules,
  user: { email: string },
): AllowDecision {
  const email = user.email.toLowerCase();

  if (rules.emails?.some((e) => e.toLowerCase() === email)) {
    return { allow: true };
  }

  const at = email.lastIndexOf("@");
  if (at !== -1) {
    const domain = email.slice(at + 1);
    if (rules.domains?.some((d) => d.toLowerCase() === domain)) {
      return { allow: true };
    }
  }

  if (rules.anySignedIn) return { allow: true };

  return { allow: false, reason: `email '${user.email}' not in allowlist` };
}
