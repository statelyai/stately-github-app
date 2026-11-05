import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export const WEBHOOK_PATH = "/api/webhook";
export const MAX_WEBHOOK_BYTES = 25 * 1024 * 1024;
export const MAX_CONCURRENT_REQUESTS = 4;
export class WebhookError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type Options = {
  secret: string;
  handleEvent: (name: string, id: string, payload: unknown) => Promise<void>;
  bodyTimeoutMs?: number;
};

function readBody(
  request: IncomingMessage,
  timeoutMs: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(
      () => fail(new WebhookError(408, "Webhook body timed out")),
      timeoutMs,
    );
    timer.unref();
    const cleanup = () => {
      clearTimeout(timer);
      request.removeListener("data", onData);
      request.removeListener("end", onEnd);
      request.removeListener("error", onError);
      request.removeListener("aborted", onAborted);
    };
    const fail = (error: WebhookError) => {
      cleanup();
      request.pause();
      reject(error);
    };
    const onData = (chunk: unknown) => {
      if (!Buffer.isBuffer(chunk)) {
        fail(new WebhookError(400, "Invalid webhook body"));
        return;
      }
      size += chunk.length;
      if (size > MAX_WEBHOOK_BYTES) {
        fail(new WebhookError(413, "Webhook body too large"));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks, size));
    };
    const onError = () =>
      fail(new WebhookError(400, "Could not read webhook body"));
    const onAborted = () => fail(new WebhookError(400, "Webhook body aborted"));
    request.on("data", onData);
    request.on("end", onEnd);
    request.on("error", onError);
    request.on("aborted", onAborted);
  });
}

export function createWebhookHandler({
  secret,
  handleEvent,
  bodyTimeoutMs = 10_000,
}: Options) {
  if (Buffer.byteLength(secret) < 32)
    throw new Error("A strong webhook secret is required");
  let active = 0;
  // Warm-instance optimization only. Registry and PR markers provide durable deduplication.
  const completed = new Map<string, number>();
  const inflight = new Map<string, Promise<void>>();
  return async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    const reject = (status: number, message: string) => {
      response.setHeader("Connection", "close");
      response.statusCode = status;
      response.end(message);
    };
    if (request.url?.split("?")[0] !== WEBHOOK_PATH) {
      reject(404, "Not found");
      return;
    }
    if (request.method !== "POST") {
      response.setHeader("Allow", "POST");
      reject(405, "Method not allowed");
      return;
    }
    if (active >= MAX_CONCURRENT_REQUESTS) {
      response.setHeader("Retry-After", "1");
      reject(503, "Webhook capacity exceeded");
      return;
    }
    active++;
    let deliveryId: string | undefined;
    try {
      const name = request.headers["x-github-event"];
      const id = request.headers["x-github-delivery"];
      const signature = request.headers["x-hub-signature-256"];
      if (
        typeof name !== "string" ||
        !/^[a-z_]{1,64}$/.test(name) ||
        typeof id !== "string" ||
        !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id) ||
        typeof signature !== "string" ||
        !/^sha256=[a-f0-9]{64}$/.test(signature)
      )
        throw new WebhookError(400, "Invalid webhook headers");
      deliveryId = id;
      const contentType = request.headers["content-type"]
        ?.split(";")[0]
        ?.trim()
        .toLowerCase();
      if (
        contentType !== "application/json" ||
        (request.headers["content-encoding"] &&
          request.headers["content-encoding"] !== "identity")
      )
        throw new WebhookError(415, "Expected uncompressed JSON");
      const length = request.headers["content-length"];
      if (
        length &&
        (!/^\d{1,10}$/.test(length) || Number(length) > MAX_WEBHOOK_BYTES)
      )
        throw new WebhookError(413, "Webhook body too large");
      const bytes = await readBody(request, bodyTimeoutMs);
      const digest = createHmac("sha256", secret).update(bytes).digest();
      if (!timingSafeEqual(digest, Buffer.from(signature.slice(7), "hex")))
        throw new WebhookError(401, "Invalid webhook signature");
      let payload: unknown;
      try {
        payload = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        );
      } catch {
        throw new WebhookError(400, "Invalid webhook JSON");
      }
      if (!payload || typeof payload !== "object" || Array.isArray(payload))
        throw new WebhookError(400, "Invalid webhook payload");
      // GitHub signs the body, not delivery headers. Changing the ID must not bypass this cache.
      const key = createHash("sha256")
        .update(name)
        .update("\0")
        .update(bytes)
        .digest("hex");
      if ((completed.get(key) ?? 0) <= Date.now()) {
        let task = inflight.get(key);
        if (!task) {
          task = Promise.resolve()
            .then(() => handleEvent(name, id, payload))
            .then(() => {
              completed.delete(key);
              completed.set(key, Date.now() + 10 * 60_000);
              if (completed.size > 1000) {
                const oldest = completed.keys().next().value;
                if (oldest) completed.delete(oldest);
              }
            });
          inflight.set(key, task);
        }
        try {
          await task;
        } finally {
          inflight.delete(key);
        }
      }
      response.end("ok\n");
    } catch (error) {
      if (!(error instanceof WebhookError))
        console.error(JSON.stringify({ event: "webhook_failed", deliveryId }));
      reject(
        error instanceof WebhookError ? error.status : 500,
        error instanceof WebhookError ? error.message : "Webhook failed",
      );
    } finally {
      active--;
    }
  };
}
