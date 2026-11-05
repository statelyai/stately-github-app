import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  createServer,
  request,
  type IncomingMessage,
  type ServerResponse,
  type OutgoingHttpHeaders,
} from "node:http";
import { readConfig } from "../lib/config.js";

export const secret = "synthetic-webhook-secret-with-32-bytes";
export const privateKey = readFileSync(
  new URL("../../../test/fixtures/mock-cert.pem", import.meta.url),
  "utf8",
);
export const headSha = "a".repeat(40);
export const repo = { id: 22, full_name: "owner/repo", default_branch: "main" };
export const push = {
  ref: "refs/heads/main",
  after: headSha,
  deleted: false,
  repository: repo,
  installation: { id: 7 },
};
export const config = (url = "") =>
  readConfig({
    APP_ID: "123",
    PRIVATE_KEY: privateKey,
    WEBHOOK_SECRET: secret,
    STATELY_DOCUMENTATION_WEBHOOK_URL: url,
  });
export function signedHeaders(body: Buffer | string, name = "push") {
  return {
    "content-type": "application/json",
    "x-github-event": name,
    "x-github-delivery": randomUUID(),
    "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
  };
}
export async function serve(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
) {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Expected TCP server");
  return {
    url: `http://127.0.0.1:${address.port}/api/webhook`,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
export function send(
  url: string,
  body: string | Buffer,
  headers: OutgoingHttpHeaders = signedHeaders(body),
  method = "POST",
) {
  return new Promise<{
    status: number;
    body: string;
    headers: IncomingMessage["headers"];
  }>((resolve, reject) => {
    const req = request(url, { method, headers, agent: false }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () =>
        resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString(),
          headers: response.headers,
        }),
      );
      response.on("error", reject);
    });
    req.on("error", reject);
    req.end(body);
  });
}
