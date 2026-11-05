import { createServer } from "node:http";
import { createApp } from "./app.js";
import { readConfig } from "./config.js";
import { createWebhookHandler } from "./webhook.js";

const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 0 || port > 65535)
  throw new Error("Invalid PORT");
const server = createServer(createWebhookHandler(createApp(readConfig())));
server.headersTimeout = 10_000;
server.requestTimeout = 15_000;
server.maxRequestsPerSocket = 100;
server.listen(port, process.env.HOST ?? "127.0.0.1");
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    server.close();
    const timer = setTimeout(() => server.closeAllConnections(), 10_000);
    timer.unref();
  });
