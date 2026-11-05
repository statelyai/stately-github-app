import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createApp } from "../lib/app.js";
import { config, serve, send, signedHeaders } from "./helpers.js";
import { github, payload } from "./fixtures/github.js";
import { createWebhookHandler } from "../lib/webhook.js";

test("signed HTTP delivery uses real SDK auth, repository-scoped tokens and paginated reads to publish a private inline diagram", async () => {
  const api = github();
  const app = createApp(config(), api.fetchImpl);
  const host = await serve(createWebhookHandler(app));
  try {
    const body = JSON.stringify(payload);
    const response = await send(
      host.url,
      body,
      signedHeaders(body, "pull_request"),
    );
    assert.equal(response.status, 200, response.body);
    assert.equal(api.writes.length, 1);
    const comment = api.writes[0]?.comments[0];
    assert.ok(comment);
    assert.equal(comment.line, 2);
    assert.match(comment.body, /```mermaid\nstateDiagram-v2/);
    assert.match(comment.body, /n0 --> n1: GO/);
    assert.equal(comment.body.includes("https://"), false);
    assert.equal(comment.body.includes("do-not-copy"), false);
    assert.ok(
      api.requests.some((request) =>
        request.includes("/comments?per_page=100&page=2"),
      ),
    );
    assert.ok(
      api.requests.some((request) =>
        request.includes("/files?per_page=100&page=2"),
      ),
    );
    // A cold/warm receiver cache is not required for the persisted marker check.
    await app.handleEvent("pull_request", randomUUID(), payload);
    assert.equal(api.writes.length, 1);
    assert.equal(
      api.requests.some((request) => /^(DELETE|PATCH) /.test(request)),
      false,
    );
  } finally {
    await host.close();
  }
});

test("does not confuse human-authored marker text with bot comments", async () => {
  const api = github({ human: true });
  const app = createApp(config(), api.fetchImpl);
  await app.handleEvent("pull_request", randomUUID(), payload);
  await app.handleEvent("pull_request", randomUUID(), payload);
  assert.equal(api.writes.length, 2);
  assert.equal(
    api.requests.some((request) => /^(DELETE|PATCH) /.test(request)),
    false,
  );
});

test("skips stale heads, heads that move during work, unrelated diff lines and oversized files", async () => {
  for (const options of [
    { stale: true },
    { moved: true },
    { outsideDiff: true },
    { large: true },
    { source: "not a machine" },
  ]) {
    const api = github(options);
    await createApp(config(), api.fetchImpl).handleEvent(
      "pull_request",
      randomUUID(),
      payload,
    );
    assert.equal(api.writes.length, 0, JSON.stringify(options));
  }
});

test("ignores unhandled PR actions without minting credentials", async () => {
  const app = createApp(config(), async () => {
    throw new Error("Unexpected API call");
  });
  await app.handleEvent("pull_request", randomUUID(), {
    ...payload,
    action: "closed",
  });
});
