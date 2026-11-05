import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { build } from "esbuild";

const output = ".vercel/output";
const functionDir = `${output}/functions/api/webhook.func`;
await rm(output, { recursive: true, force: true });
await mkdir(`${functionDir}/dist`, { recursive: true });
await build({
  entryPoints: ["api/webhook.ts"],
  outfile: `${functionDir}/index.cjs`,
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
});
await copyFile(
  "dist/parser-worker.cjs",
  `${functionDir}/dist/parser-worker.cjs`,
);
await writeFile(`${output}/config.json`, JSON.stringify({ version: 3 }));
await writeFile(
  `${functionDir}/.vc-config.json`,
  JSON.stringify({
    runtime: "nodejs24.x",
    handler: "index.cjs",
    launcherType: "Nodejs",
    shouldAddHelpers: false,
    maxDuration: 60,
  }),
);
