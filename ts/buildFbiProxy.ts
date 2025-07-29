import fsp from "fs/promises";
import { getProxyFilename } from "./getProxyFilename";
import { fromStdio } from 'from-node-stream'
import { copyFile } from "fs/promises";
import { $ } from "./dRun";

if (import.meta.main) {
    await buildFbiProxy()
}

export async function buildFbiProxy({ rebuild = true } = {}) {
    const isWin = process.platform === 'win32';

    const binaryName = getProxyFilename();
    const built = './release/' + binaryName;
    if (!rebuild && await fsp.exists(built))
        return built;

    await $.cwd('./rs')`cargo build --release`;

    await copyFile(`./target/release/fbi-proxy${isWin ? '.exe' : ''}`, built)
    return await fsp.exists(built) && ('./release/' + binaryName);
}
