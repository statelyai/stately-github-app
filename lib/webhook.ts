import { IncomingMessage, ServerResponse } from "http";
import { Probot } from "probot";
import { probotApp } from "./app";

export const WEBHOOK_PATH = "/api/webhook";
export const MAX_WEBHOOK_BYTES = 25 * 1024 * 1024;
class WebhookBodyError extends Error {
  constructor(readonly status: number, message: string) { super(message); Object.setPrototypeOf(this, WebhookBodyError.prototype); }
}

function readWebhookBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      request.removeListener("data", onData);
      request.removeListener("end", onEnd);
      request.removeListener("error", onError);
      request.removeListener("aborted", onAborted);
    };
    const fail = (error: WebhookBodyError) => { cleanup(); request.pause(); reject(error); };
    const onData = (chunk: unknown) => {
      if (typeof chunk !== "string" && !Buffer.isBuffer(chunk)) {
        fail(new WebhookBodyError(400, "Invalid webhook body")); return;
      }
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      size += bytes.length;
      if (size > MAX_WEBHOOK_BYTES) { fail(new WebhookBodyError(413, "Webhook body too large")); return; }
      chunks.push(bytes);
    };
    const onEnd = () => {
      cleanup();
      const bytes = Buffer.concat(chunks);
      const body = bytes.toString("utf8");
      if (!Buffer.from(body, "utf8").equals(bytes)) { reject(new WebhookBodyError(400, "Invalid UTF-8")); return; }
      resolve(body);
    };
    const onError = () => fail(new WebhookBodyError(400, "Could not read webhook body"));
    const onAborted = () => fail(new WebhookBodyError(400, "Webhook body aborted"));
    request.on("data", onData);
    request.on("end", onEnd);
    request.on("error", onError);
    request.on("aborted", onAborted);
  });
}

export function createWebhookHandler(probot: Probot) {
  const loaded = probot.load(probotApp);
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (request.url?.split("?")[0] !== WEBHOOK_PATH) {
      response.writeHead(404, { Connection: "close" }); response.end(); return;
    }
    if (request.method !== "POST") {
      response.writeHead(405, { Allow: "POST", Connection: "close" }); response.end(); return;
    }
    try {
      const name = request.headers["x-github-event"];
      const id = request.headers["x-github-delivery"];
      const signature = request.headers["x-hub-signature-256"];
      if (typeof name !== "string" || !name || typeof id !== "string" || !id || typeof signature !== "string" || !/^sha256=[a-f0-9]{64}$/.test(signature))
        throw new WebhookBodyError(400, "Missing webhook headers");
      const body = await readWebhookBody(request);
      if (!body || !probot.webhooks.verify(body, signature)) throw new WebhookBodyError(401, "Invalid webhook signature");
      let payload: unknown;
      try { payload = JSON.parse(body); } catch { throw new WebhookBodyError(400, "Invalid webhook JSON"); }
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) throw new WebhookBodyError(400, "Invalid webhook payload");
      await loaded;
      // Probot 11's middleware combines verification and parsing; verify exact bytes first.
      await probot.webhooks.receive({ name, id, payload });
      response.end("ok\n");
    } catch (error) {
      if (response.headersSent) return;
      response.writeHead(error instanceof WebhookBodyError ? error.status : 500, { Connection: "close" });
      response.end(error instanceof WebhookBodyError ? error.message : "Webhook failed");
    }
  };
}
