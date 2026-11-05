import type { IncomingMessage, ServerResponse } from "node:http";
import { createApp } from "../lib/app.js";
import { readConfig } from "../lib/config.js";
import { createWebhookHandler } from "../lib/webhook.js";

let handler: ReturnType<typeof createWebhookHandler> | undefined;
export default async function webhook(
  request: IncomingMessage,
  response: ServerResponse,
) {
  try {
    handler ??= createWebhookHandler(createApp(readConfig()));
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
  await handler(request, response);
}
