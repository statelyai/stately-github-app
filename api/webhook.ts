import { waitUntil } from "@vercel/functions";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createApp } from "../lib/app.js";
import { readConfig } from "../lib/config.js";
import { createWebhookHandler } from "../lib/webhook.js";

let app: ReturnType<typeof createApp> | undefined;
let handler: ReturnType<typeof createWebhookHandler> | undefined;
export default async function webhook(
  request: IncomingMessage,
  response: ServerResponse,
) {
  try {
    app ??= createApp(readConfig(), undefined, { waitUntil });
    handler ??= createWebhookHandler(app);
  } catch {
    console.error(JSON.stringify({ event: "invalid_app_configuration" }));
    response.writeHead(503, {
      "Content-Type": "text/plain",
      "Cache-Control": "no-store",
      Connection: "close",
    });
    response.end("Webhook unavailable");
    return;
  }
  if (await app.handleReplayRequest(request, response)) return;
  await handler(request, response);
}
