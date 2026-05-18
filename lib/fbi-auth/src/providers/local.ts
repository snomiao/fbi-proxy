import { scrypt, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options?: { N?: number; r?: number; p?: number; maxmem?: number },
) => Promise<Buffer>;

const KEY_LEN = 64;
const SCRYPT_N = 16384; // 2^14 — balanced for fast boot, still costly enough for an offline attacker
const SCRYPT_R = 8;
const SCRYPT_P = 1;

export type LocalUser = {
  email: string;
  name?: string;
};

export type LocalCredentials = {
  user: LocalUser;
  passwordHash: Buffer;
  salt: Buffer;
};

export type LocalProvider = {
  user: LocalUser;
  verify(password: string): Promise<boolean>;
};

export async function hashPassword(
  password: string,
  salt?: Buffer,
): Promise<{ hash: Buffer; salt: Buffer }> {
  const s = salt ?? randomBytes(16);
  const hash = await scryptAsync(password, s, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return { hash, salt: s };
}

export function makeLocalProvider(creds: LocalCredentials): LocalProvider {
  return {
    user: creds.user,
    async verify(password) {
      try {
        const { hash } = await hashPassword(password, creds.salt);
        if (hash.length !== creds.passwordHash.length) return false;
        return timingSafeEqual(hash, creds.passwordHash);
      } catch {
        return false;
      }
    },
  };
}

export async function makeLocalProviderFromPassword(opts: {
  email: string;
  name?: string;
  password: string;
}): Promise<LocalProvider> {
  const { hash, salt } = await hashPassword(opts.password);
  return makeLocalProvider({
    user: { email: opts.email, name: opts.name },
    passwordHash: hash,
    salt,
  });
}
