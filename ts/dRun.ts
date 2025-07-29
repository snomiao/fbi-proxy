import { spawn } from "child_process";
import { fromReadable } from "from-node-stream";
import tsaComposer from "tsa-composer";

export const dRun = ({ cwd = process.cwd(), env = process.env as Record<string, string> } = {}) => tsaComposer((s: string) => s, (...slots) => {
    // TODO: parse slots for quotes
    const [bin, ...args] = slots.join(' ').split(' ');
    const p = spawn(bin, args, { env, cwd });
    p.stderr?.pipe(process.stderr);
    const print = new TransformStream({
        transform(chunk, controller) {
            if (typeof chunk === 'string') {
                console.log(chunk);
            } else if (chunk instanceof Uint8Array) {
                console.log(new TextDecoder().decode(chunk));
            }
            controller.enqueue(chunk);
        }
    });
    const resp = new Response(fromReadable(p.stdout).pipeThrough(print));
    return Object.assign(new Promise<string>(
        (resolve, reject) => {
            p.on('error', reject);
            p.on('exit', async (code) => {
                if (code !== 0) {
                    reject(new Error(`Process exited with code ${code}`));
                } else {
                    resolve(await resp.text());
                }
            });
        }
    ), {
        text: () => resp.text(),
        json: () => resp.json(),
        blob: () => resp.blob(),
        arrayBuffer: () => resp.arrayBuffer(),
        code: new Promise<number>((resolve) => {
            p.on('exit', resolve);
        }),
        ok: new Promise<boolean>((resolve) => {
            p.on('exit', (code) => {
                resolve(code === 0);
            });
        })
    });
});

export const $ = Object.assign(dRun(), { opt: dRun, cwd: (path: string) => dRun({ cwd: path }) });
