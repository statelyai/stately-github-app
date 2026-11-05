import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { afterEach, test } from "node:test";
import nock from "nock";
import { createApp } from "../lib/app.js";
import { forwardDocumentationEvent } from "../lib/documentation.js";
import { createWebhookHandler } from "../lib/webhook.js";
import { config, secret, push, serve, send, signedHeaders } from "./helpers.js";

afterEach(() => {
  nock.cleanAll();
  nock.enableNetConnect();
});

test("large signed default-branch pushes forward only compact facts with a new signature", async () => {
  const body = JSON.stringify(push);
  const scope = nock("https://stately.test", {
    reqheaders: {
      "x-github-event": "push",
      "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
    },
  })
    .post("/documentation", push)
    .reply(202, { accepted: true });
  const app = createApp(
    config("https://stately.test/documentation"),
    async () => {
      throw new Error("No GitHub source reads for forwarding");
    },
  );
  const host = await serve(createWebhookHandler(app));
  try {
    const raw = JSON.stringify(
      {
        ...push,
        commits: [{ message: "x".repeat(1_100_000) }],
        token: "must-not-forward",
        repository: { ...push.repository, private: true },
      },
      null,
      2,
    );
    assert.equal((await send(host.url, raw)).status, 200);
    assert.ok(scope.isDone());
  } finally {
    await host.close();
  }
});

test("ignores feature branches, deletions, missing installations and disabled forwarding", async () => {
  nock.disableNetConnect();
  const app = createApp(config("https://stately.test/documentation"));
  await app.handleEvent("push", randomUUID(), {
    ...push,
    ref: "refs/heads/feature/test",
  });
  await app.handleEvent("push", randomUUID(), { ...push, deleted: true });
  await app.handleEvent("push", randomUUID(), {
    ...push,
    installation: undefined,
  });
  await createApp(config()).handleEvent("push", randomUUID(), push);
});

test("forwards revocations with no account, source or credential fields", async () => {
  const app = createApp(config("https://stately.test/documentation"));
  for (const action of ["deleted", "suspend"]) {
    const scope = nock("https://stately.test")
      .post("/documentation", { action, installation: { id: 7 } })
      .reply(202);
    await app.handleEvent("installation", randomUUID(), {
      action,
      installation: { id: 7, access_tokens_url: "private" },
      sender: { secret },
    });
    assert.ok(scope.isDone());
  }
  const scope = nock("https://stately.test")
    .post("/documentation", {
      action: "removed",
      installation: { id: 7 },
      repositories_removed: [{ id: 22 }],
    })
    .reply(202);
  await app.handleEvent("installation_repositories", randomUUID(), {
    action: "removed",
    installation: { id: 7 },
    repositories_removed: [{ id: 22, full_name: "private" }],
    extra: secret,
  });
  assert.ok(scope.isDone());
});

test("rejects wrong event shapes before work and rejects redirect/unsafe forward targets", async () => {
  const app = createApp(config("https://stately.test/documentation"));
  const host = await serve(createWebhookHandler(app));
  try {
    assert.equal(
      (await send(host.url, "{}", signedHeaders("{}", "push"))).status,
      400,
    );
  } finally {
    await host.close();
  }
  for (const target of [
    "http://stately.test",
    "https://user:pass@stately.test",
    "https://stately.test?secret=x",
    "https://stately.test/#fragment",
  ]) {
    await assert.rejects(
      forwardDocumentationEvent(
        "push",
        randomUUID(),
        {},
        { STATELY_DOCUMENTATION_WEBHOOK_URL: target, WEBHOOK_SECRET: secret },
      ),
    );
  }
  const scope = nock("https://stately.test")
    .post("/documentation")
    .reply(302, "", { location: "https://other.test/" });
  await assert.rejects(
    forwardDocumentationEvent(
      "push",
      randomUUID(),
      {},
      {
        STATELY_DOCUMENTATION_WEBHOOK_URL: "https://stately.test/documentation",
        WEBHOOK_SECRET: secret,
      },
    ),
    /delivery failed/,
  );
  assert.ok(scope.isDone());
});
