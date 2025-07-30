import { existsSync } from "fs";
import fsp from "fs/promises";
import { $ } from "./dRun";

export const downloadCaddy = async () => {
  // use pwdCaddy if already downloaded
  const pwdCaddy = "./caddy";

  // if ./caddy exists in pwd, return it
  if (existsSync(pwdCaddy)) return pwdCaddy;

  // or use system caddy if installed, run `caddy --version` to check
  if (await $`caddy --version`.catch(() => false)) {
    return "caddy";
  }

  // or if system caddy is not installed, download caddy using caddy-baron
  if (!existsSync(pwdCaddy)) {
    // download latest caddy to ./caddy
    console.log("Downloading Caddy...");
    // @ts-ignore
    await import("../node_modules/caddy-baron/index.mjs");

    if (!existsSync(pwdCaddy))
      throw new Error(
        "Failed to download Caddy. Please install Caddy manually or check your network connection.",
      );
  }

  return pwdCaddy;
};
