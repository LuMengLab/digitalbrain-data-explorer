import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });
await mkdir("dist/server", { recursive: true });
await mkdir("dist/client", { recursive: true });
await mkdir("dist/.openai", { recursive: true });
await cp("public/data", "dist/client/data", { recursive: true });
await cp("public/_headers", "dist/client/_headers");
await cp("worker/index.js", "dist/server/index.js");
const hosting = JSON.parse(await readFile(".openai/hosting.json", "utf8"));
await writeFile("dist/.openai/hosting.json", JSON.stringify(hosting));
