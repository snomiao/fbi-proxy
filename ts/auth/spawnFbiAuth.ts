import path from "node:path";
import getPort from "get-port";
import { $ } from "../dSpawn";

export type FbiAuthHandle = {
  port: number;
  pid: number | undefined;
  kill: () => void;
};

export async function spawnFbiAuth(opts: {
  configPath: string;
  preferredPort?: number;
}): Promise<FbiAuthHandle> {
  const port = await getPort({ port: opts.preferredPort ?? 2433 });
  const entry = path.resolve(
    import.meta.dir,
    "..",
    "..",
    "lib",
    "fbi-auth",
    "src",
    "server.ts",
  );

  const proc = $.opt({
    env: {
      ...process.env,
      FBI_AUTH_PORT: String(port),
      FBI_AUTH_CONFIG_PATH: opts.configPath,
    },
  })`bun ${entry}`.process;

  proc.on("exit", (code) => {
    console.log(`[fbi-auth] exited with code ${code}`);
  });

  return {
    port,
    pid: proc.pid,
    kill: () => proc.kill?.(),
  };
}
