import { ChildProcess, spawn } from "child_process";
import { fromReadable } from "from-node-stream";
import tsaComposer from "tsa-composer";

type DRunProc = Promise<{
  out: string;
  err: string;
  code: number;
}> & {
  out: Promise<string>;
  err: Promise<string>;
  stdout: ReadableStream;
  stderr: ReadableStream;
  code: Promise<number>;
  process: ChildProcess;
};

const dSpawn = ({
  cwd = process.cwd(),
  env = process.env as Record<string, string>,
} = {}) =>
  tsaComposer(
    // slot is un dividable
    (slot: string | { raw: string }) =>
      typeof slot === "string"
        ? {
            raw: String(slot), // todo: escape quotes
          }
        : slot,
    (...slots): DRunProc => {
      try {
        // TODO: parse slots for quotes
        const [bin, ...args] = slots
          .flatMap((e) => (typeof e === "string" ? e.split(" ") : e.raw))
          .join(" ")
          .split(" ")
          .filter((e) => e !== "");
        console.log("Running command:", bin, args);
        const p = spawn(bin, args, { env, cwd });
        p.stderr?.pipe(process.stderr);
        const print = new TransformStream({
          transform(chunk, controller) {
            if (typeof chunk === "string") {
              console.log(chunk);
            } else if (chunk instanceof Uint8Array) {
              console.log(new TextDecoder().decode(chunk));
            }
            controller.enqueue(chunk);
          },
        });
        // Create readable streams for stdout and stderr
        const stdoutStream = fromReadable(p.stdout).pipeThrough(print);
        const stderrStream = fromReadable(p.stderr);

        // Tee the streams once to create separate branches
        const [stdoutForText, stdoutForProperty] = stdoutStream.tee();
        const [stderrForText, stderrForProperty] = stderrStream.tee();

        // Create lazy promises for collecting full output
        const outPromise = new Response(stdoutForText).text();
        const errPromise = new Response(stderrForText).text();
        const codePromise = new Promise<number>((resolve) => {
          p.on("exit", (code) => resolve(code || 0));
        });

        // Main promise that resolves with combined result (also lazy)
        const mainPromise = Promise.all([
          outPromise,
          errPromise,
          codePromise,
        ]).then(([out, err, code]) => ({ out, err, code }));

        // Create the proxy object that combines Promise with additional properties
        const result = new Proxy(mainPromise, {
          get(target, prop) {
            if (prop === "out") return outPromise;
            if (prop === "err") return errPromise;
            if (prop === "stdout") return stdoutForProperty;
            if (prop === "stderr") return stderrForProperty;
            if (prop === "code") return codePromise;
            if (prop === "process") return p;

            // For all other properties, delegate to the Promise
            const value = (target as any)[prop];
            return typeof value === "function" ? value.bind(target) : value;
          },
        });

        return result as DRunProc;
      } catch (error) {
        // Create a rejected promise that also has the required properties
        const rejectedPromise = Promise.reject(error);
        return new Proxy(rejectedPromise, {
          get(target, prop) {
            if (prop === "out") return Promise.reject(error);
            if (prop === "err") return Promise.reject(error);
            if (prop === "stdout") return new ReadableStream();
            if (prop === "stderr") return new ReadableStream();
            if (prop === "code") return Promise.reject(error);
            if (prop === "process") return null;

            const value = (target as any)[prop];
            return typeof value === "function" ? value.bind(target) : value;
          },
        }) as unknown as DRunProc;
      }
    },
  );

export const $ = Object.assign(dSpawn(), {
  opt: dSpawn,
  cwd: (path: string) => dSpawn({ cwd: path }),
});
