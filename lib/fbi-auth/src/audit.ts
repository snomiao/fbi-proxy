import { appendFile, mkdir, chmod } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export type AuditEvent =
  | {
      type: "signin.success";
      provider: string;
      sub: string;
      email: string;
      rd?: string;
    }
  | {
      type: "signin.fail.allowlist";
      provider: string;
      email: string;
      reason: string;
    }
  | { type: "signin.fail.oauth"; provider: string; reason: string }
  | { type: "signin.fail.firebase"; reason: string }
  | { type: "verify.fail"; reason: "missing" | "invalid" | "expired" }
  | {
      type: "session.refresh";
      sub: string;
      email: string;
      remainingSec: number;
    }
  | { type: "logout"; sub?: string; email?: string };

export type AuditLogger = {
  log(event: AuditEvent, meta?: AuditMeta): Promise<void>;
  path(): string;
};

export type AuditMeta = {
  ip?: string;
  userAgent?: string;
  host?: string;
};

export function defaultAuditPath(): string {
  return (
    process.env.FBI_AUTH_AUDIT_PATH ??
    join(
      process.env.XDG_STATE_HOME ?? join(homedir(), ".config"),
      "fbi-proxy",
      "audit.log",
    )
  );
}

export function makeAuditLogger(opts?: {
  path?: string;
  enabled?: boolean;
}): AuditLogger {
  const path = opts?.path ?? defaultAuditPath();
  const enabled = opts?.enabled ?? auditEnabledFromEnv();
  let dirEnsured = false;

  return {
    path: () => path,
    async log(event, meta) {
      if (!enabled) return;
      const line =
        JSON.stringify({
          ts: new Date().toISOString(),
          ...event,
          ...(meta?.ip ? { ip: meta.ip } : {}),
          ...(meta?.userAgent ? { ua: meta.userAgent } : {}),
          ...(meta?.host ? { host: meta.host } : {}),
        }) + "\n";
      try {
        if (!dirEnsured) {
          await mkdir(dirname(path), { recursive: true });
          dirEnsured = true;
        }
        await appendFile(path, line, { encoding: "utf8" });
        await chmod(path, 0o600).catch(() => {});
      } catch (err) {
        // Never let audit logging crash the auth flow.
        console.error(
          `[fbi-auth] audit log write failed: ${(err as Error).message}`,
        );
      }
    },
  };
}

function auditEnabledFromEnv(): boolean {
  const v = process.env.FBI_AUTH_AUDIT;
  if (v === undefined) return true;
  return v !== "0" && v !== "false";
}

export function extractMeta(req: {
  header: (name: string) => string | undefined;
}): AuditMeta {
  return {
    ip:
      req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
      req.header("x-real-ip") ??
      undefined,
    userAgent: req.header("user-agent"),
    host: req.header("x-forwarded-host") ?? req.header("host"),
  };
}
