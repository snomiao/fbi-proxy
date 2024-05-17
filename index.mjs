import { readFile, writeFile } from "fs/promises";
import yaml from "yaml";

await writeFile("Caddyfile", await caddyFileCompose());

async function caddyFileCompose() {
  return (
    await Promise.all([
      readFile("Caddyfile.head", "utf8"),
      readFile("services.yaml", "utf8")
        .then(yaml.parse)
        .catch(() => ({}))
        .then((services) =>
          Object.entries(services).map(([service, to]) => site(service, to))
        ),
      Object.keys(process.env)
        .filter((e) => e.startsWith("FBI_PROXY_"))
        .map((e) => site(e.split("_").slice(2).join("_"), process.env[e])),
    ])
  )
    .flat()
    .join("\n\n");
}

function site(service, to) {
  return `
http://${String(service).toLowerCase()}.fbi.com {
  reverse_proxy ${to}
}
    `.trim();
}
