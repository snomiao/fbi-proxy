import { getProxyFilename } from "./getProxyFilename";

// download latest github release
// https://github.com/snomiao/fbi-proxy/releases/download/v1.2.0/proxy-windows-x64.exe
// https://github.com/snomiao/fbi-proxy/releases/latest/download/fbi-proxy-windows-x64.exe
const url = 'https://github.com/snomiao/fbi-proxy/releases/latest/download/' + getProxyFilename()
console.log(url)

// const res = await fetch()
// if (!res.ok) {
//   throw new Error("Failed to download proxy file: " + res.statusText);
// }
// // show progress
// const progress = new ReadableStream({
//     start(controller) {
//         const reader = res.body.getReader();
//         let loaded = 0;
//         const total = Number(res.headers.get('Content-Length'));
//         function push() {
//         reader.read().then(({ done, value }) => {
//             if (done) {
//             controller.close();
//             return;
//             }
//             loaded += value.length;
//             console.log(`Downloaded ${((loaded / total) * 100).toFixed(2)}%`);
//             controller.enqueue(value);
//             push();
//         });
//         }
//         push();
//     }
//     });
// console.log(await Bun.write(('release/' + getProxyFilename()), progress))

