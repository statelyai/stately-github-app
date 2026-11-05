import assert from "node:assert/strict";
import { request } from "node:http";
import { mock, test } from "node:test";
import {
  createWebhookHandler,
  MAX_WEBHOOK_BYTES,
  MAX_CONCURRENT_REQUESTS,
} from "../lib/webhook.js";
import { secret, serve, send, signedHeaders, push } from "./helpers.js";

test("authenticates exact bytes, including whitespace, Unicode and a >1 MB delivery", async () => {
  const received: unknown[] = [];
  const host = await serve(
    createWebhookHandler({
      secret,
      handleEvent: async (...event) => {
        received.push(event);
      },
    }),
  );
  try {
    const body = JSON.stringify(
      { ...push, commits: [{ message: "é".repeat(600_000) }] },
      null,
      2,
    );
    assert.equal((await send(host.url, body)).status, 200);
    assert.equal(received.length, 1);
    assert.equal(
      (
        await send(
          host.url,
          body,
          signedHeaders(JSON.stringify(JSON.parse(body))),
        )
      ).status,
      401,
    );
    assert.equal(received.length, 1);
  } finally {
    await host.close();
  }
});

test("rejects tampering, SHA1-only auth, invalid UTF-8, non-object JSON and encoded bodies", async () => {
  let count = 0;
  const host = await serve(
    createWebhookHandler({
      secret,
      handleEvent: async () => {
        count++;
      },
    }),
  );
  try {
    const body = "{}";
    assert.equal(
      (await send(host.url, '{"tampered":true}', signedHeaders(body))).status,
      401,
    );
    assert.equal(
      (
        await send(host.url, body, {
          ...signedHeaders(body),
          "x-hub-signature-256": "",
        })
      ).status,
      400,
    );
    const invalid = Buffer.from([0xff, 0xfe]);
    assert.equal((await send(host.url, invalid)).status, 400);
    assert.equal((await send(host.url, "[]")).status, 400);
    assert.equal((await send(host.url, "null")).status, 400);
    assert.equal(
      (
        await send(host.url, body, {
          ...signedHeaders(body),
          "content-type": "text/plain",
        })
      ).status,
      415,
    );
    assert.equal(
      (
        await send(host.url, body, {
          ...signedHeaders(body),
          "content-encoding": "gzip",
        })
      ).status,
      415,
    );
    assert.equal(count, 0);
  } finally {
    await host.close();
  }
});

test("enforces the only route, method, valid headers and no-store responses", async () => {
  const host = await serve(
    createWebhookHandler({ secret, handleEvent: async () => {} }),
  );
  try {
    assert.equal(
      (await send(host.url.replace("/api/webhook", "/other"), "{}")).status,
      404,
    );
    const get = await send(host.url, "", signedHeaders(""), "GET");
    assert.equal(get.status, 405);
    assert.equal(get.headers.allow, "POST");
    assert.equal(get.headers["cache-control"], "no-store");
    assert.equal(
      (
        await send(host.url, "{}", {
          ...signedHeaders("{}"),
          "x-github-delivery": "not-a-guid",
        })
      ).status,
      400,
    );
  } finally {
    await host.close();
  }
});

test("bounds bytes actually read on chunked requests before authentication", async () => {
  let count = 0;
  const host = await serve(
    createWebhookHandler({
      secret,
      handleEvent: async () => {
        count++;
      },
    }),
  );
  try {
    const body = Buffer.alloc(MAX_WEBHOOK_BYTES + 1024, 32);
    const headers = { ...signedHeaders("{}"), "transfer-encoding": "chunked" };
    assert.equal((await send(host.url, body, headers)).status, 413);
    assert.equal(count, 0);
  } finally {
    await host.close();
  }
});

test("expires slow bodies and caps concurrent readers", async () => {
  const host = await serve(
    createWebhookHandler({
      secret,
      handleEvent: async () => {},
      bodyTimeoutMs: 150,
    }),
  );
  const clients: ReturnType<typeof request>[] = [];
  try {
    const results = Array.from(
      { length: MAX_CONCURRENT_REQUESTS },
      () =>
        new Promise<number>((resolve, reject) => {
          const client = request(
            host.url,
            {
              method: "POST",
              headers: {
                ...signedHeaders("{}"),
                "transfer-encoding": "chunked",
              },
              agent: false,
            },
            (response) => {
              response.resume();
              response.once("end", () => resolve(response.statusCode ?? 0));
            },
          );
          client.on("error", reject);
          client.flushHeaders();
          clients.push(client);
        }),
    );
    // A valid body read behind those sockets observes the capacity bound.
    const result = await send(host.url, "{}");
    assert.equal(result.status, 503);
    assert.equal(result.headers["retry-after"], "1");
    assert.deepEqual(await Promise.all(results), [408, 408, 408, 408]);
  } finally {
    for (const client of clients) client.destroy();
    await host.close();
  }
});

test("deduplicates concurrent and changed-delivery-ID replays within the instance", async () => {
  let count = 0;
  const host = await serve(
    createWebhookHandler({
      secret,
      handleEvent: async () => {
        count++;
        await new Promise((resolve) => setImmediate(resolve));
      },
    }),
  );
  try {
    assert.deepEqual(
      (await Promise.all([send(host.url, "{}"), send(host.url, "{}")])).map(
        (result) => result.status,
      ),
      [200, 200],
    );
    assert.equal((await send(host.url, "{}")).status, 200);
    assert.equal(count, 1);
  } finally {
    await host.close();
  }
});

test("failed work is retryable and diagnostics cannot expose SDK errors or credentials", async () => {
  let count = 0;
  const log = mock.method(console, "error", () => {});
  const host = await serve(
    createWebhookHandler({
      secret,
      handleEvent: async () => {
        if (++count === 1) throw new Error(`authorization: ${secret}`);
      },
    }),
  );
  try {
    const result = await send(host.url, "{}");
    assert.equal(result.status, 500);
    assert.equal(result.body, "Webhook failed");
    assert.equal(JSON.stringify(log.mock.calls).includes(secret), false);
    assert.equal((await send(host.url, "{}")).status, 200);
    assert.equal(count, 2);
  } finally {
    await host.close();
    log.mock.restore();
  }
});

test("aborted sockets release capacity and leave the server usable", async () => {
  const host = await serve(
    createWebhookHandler({ secret, handleEvent: async () => {} }),
  );
  try {
    await new Promise<void>((resolve, reject) => {
      const client = request(host.url, {
        method: "POST",
        headers: { ...signedHeaders("{}"), "transfer-encoding": "chunked" },
        agent: false,
      });
      client.on("error", (error) => {
        if ("code" in error && error.code === "ECONNRESET") resolve();
        else reject(error);
      });
      client.once("socket", (socket) =>
        socket.once("connect", () => {
          client.flushHeaders();
          client.write("{");
          setImmediate(() => client.destroy());
        }),
      );
      client.once("close", resolve);
    });
    assert.equal((await send(host.url, "{}")).status, 200);
  } finally {
    await host.close();
  }
});
