import { existsSync } from "fs";
import { $ } from "./dSpawn";

if (import.meta.main) {
  // if this file is run directly, download caddy
  const caddy = await downloadCaddy();
  console.log(`Caddy downloaded to: ${caddy}`);
  process.exit(0);
}

export async function downloadCaddy() {
  // use pwdCaddy if already downloaded
  const pwdCaddy = "./node_modules/.bin/caddy";
  if (existsSync(pwdCaddy)) return pwdCaddy;

  // // or use system caddy if installed, run `caddy --version` to check
  if (await $`caddy --version`.catch(() => false)) {
    return "caddy";
  }

  throw new Error(
    "Failed to download Caddy. Please install Caddy manually or check your network connection.",
  );
}
