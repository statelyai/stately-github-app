import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, readFile, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { privateKey, secret } from "./helpers.js";

test("deployable artifact runs signed PR processing and parser workers without node_modules or Vercel body helpers", async () => {
  const target = resolve(".scratch", `artifact-proof-${randomUUID()}`);
  await cp(".vercel/output/functions/api/webhook.func", target, {
    recursive: true,
  });
  try {
    assert.deepEqual((await readdir(target)).sort(), [
      ".vc-config.json",
      "dist",
      "index.cjs",
    ]);
    const metadata: unknown = JSON.parse(
      await readFile(`${target}/.vc-config.json`, "utf8"),
    );
    assert.deepEqual(metadata, {
      runtime: "nodejs24.x",
      handler: "index.cjs",
      launcherType: "Nodejs",
      shouldAddHelpers: false,
      maxDuration: 60,
    });
    const harness = `
      import assert from 'node:assert/strict';
      import {createRequire} from 'node:module';
      import {github,payload} from ${JSON.stringify(new URL("./fixtures/github.js", import.meta.url).href)};
      import {serve,send,signedHeaders} from ${JSON.stringify(new URL("./helpers.js", import.meta.url).href)};
      const api=github(); globalThis.fetch=api.fetchImpl;
      const require=createRequire(import.meta.url);
      const handler=require('./index.cjs').default;
      const host=await serve(handler);
      try {
        const body=JSON.stringify(payload);
        const response=await send(host.url,body,signedHeaders(body,'pull_request'));
        assert.equal(response.status,200,response.body);
        assert.equal(api.writes.length,1);
        assert.match(api.writes[0].comments[0].body,/stateDiagram-v2/);
        assert.equal((await send(host.url,body,{...signedHeaders(body),'x-hub-signature-256':'sha256='+'0'.repeat(64)})).status,401);
        console.log('artifact_verified');
      } finally {await host.close();}
    `;
    const result = await promisify(execFile)(
      process.execPath,
      ["--input-type=module", "--eval", harness],
      {
        cwd: target,
        env: { APP_ID: "123", PRIVATE_KEY: privateKey, WEBHOOK_SECRET: secret },
        timeout: 15_000,
      },
    );
    assert.match(result.stdout, /artifact_verified/);
    assert.equal(result.stderr, "");
  } finally {
    await rm(target, { recursive: true, force: true });
  }
});
