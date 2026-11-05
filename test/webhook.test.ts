import { createHmac } from "crypto";
import { readFileSync } from "fs";
import { createServer, request } from "http";
import { join } from "path";
import nock from "nock";
import { Probot } from "probot";
import { createWebhookHandler, MAX_WEBHOOK_BYTES } from "../lib/webhook";

const secret = "synthetic-webhook-secret";
const privateKey = readFileSync(join(__dirname, "fixtures/mock-cert.pem"), "utf8");
const originalEnv = { ...process.env };
const push = { ref: "refs/heads/main", after: "a".repeat(40), deleted: false, repository: { id: 456, full_name: "owner/app", default_branch: "main" }, installation: { id: 123 } };

async function deliver(body: string | Buffer, headers: Record<string, string> = {}, path = "/api/webhook") {
  const probot = new Probot({ appId: 123, privateKey, secret, webhookPath: "/api/webhook", logLevel: "fatal" });
  const server = createServer(createWebhookHandler(probot));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No test server address");
    return await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const outgoing = request({ hostname: "127.0.0.1", port: address.port, path, method: "POST", agent: false, headers: {
        "content-type": "application/json", "x-github-event": "push", "x-github-delivery": "test-delivery",
        "x-hub-signature": `sha1=${createHmac("sha1", secret).update(body).digest("hex")}`,
        "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`, ...headers,
      } }, response => {
        let result = "";
        response.on("data", chunk => { result += chunk; });
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body: result }));
        response.on("error", reject);
      });
      outgoing.on("error", reject);
      outgoing.end(body);
    });
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}

beforeEach(() => {
  process.env.STATELY_DOCUMENTATION_WEBHOOK_URL = "https://stately.test/documentation";
  process.env.WEBHOOK_SECRET = secret;
  nock.disableNetConnect(); nock.enableNetConnect("127.0.0.1");
});
afterEach(() => { process.env = { ...originalEnv }; nock.cleanAll(); nock.enableNetConnect(); });

test("the real HTTP route verifies exact JSON and forwards only the compact default-branch facts", async () => {
  const body = JSON.stringify({ ...push, commits: [{ message: "x".repeat(1_100_000) }] }, null, 2);
  const forwarded = JSON.stringify(push);
  const scope = nock("https://stately.test", { reqheaders: { "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(forwarded).digest("hex")}` } }).post("/documentation", push).reply(202);
  expect((await deliver(body)).status).toBe(200);
  expect(scope.isDone()).toBe(true);
});
test("feature branches and deletions never reach the documentation service", async () => {
  expect((await deliver(JSON.stringify({ ...push, ref: "refs/heads/topic" }))).status).toBe(200);
  expect((await deliver(JSON.stringify({ ...push, deleted: true }))).status).toBe(200);
});
test("bad signatures and invalid UTF-8 cannot reach the forwarder", async () => {
  expect((await deliver(JSON.stringify(push), { "x-hub-signature-256": "sha256=" + "0".repeat(64) })).status).toBe(401);
  expect((await deliver(Buffer.from([0xff]))).status).toBe(400);
});
test("bounds actual chunked request bytes before Probot or forwarding", async () => {
  const body = Buffer.alloc(MAX_WEBHOOK_BYTES + 1, " ");
  expect((await deliver(body, { "transfer-encoding": "chunked" })).status).toBe(413);
});
test("installation revocation forwards only the necessary facts", async () => {
  const event = { action: "deleted", installation: { id: 123 }, account: { privateMetadata: "omitted" } };
  const scope = nock("https://stately.test").post("/documentation", { action: "deleted", installation: { id: 123 } }).reply(202);
  expect((await deliver(JSON.stringify(event), { "x-github-event": "installation" })).status).toBe(200);
  expect(scope.isDone()).toBe(true);
});


test("PR synchronization still reaches the existing visualization handler", async () => {
  const base = "b".repeat(40), head = "a".repeat(40);
  const event = { action: "synchronize", number: 5, installation: { id: 123 },
    repository: { id: 456, name: "app", full_name: "owner/app", owner: { login: "owner" } },
    pull_request: { number: 5, base: { sha: base }, head: { sha: head } },
  };
  const github = nock("https://api.github.com")
    .post("/app/installations/123/access_tokens").reply(200, { token: "synthetic-installation-token", expires_at: "2099-01-01T00:00:00Z" })
    .get("/repos/owner/app/pulls/5/comments").reply(200, [])
    .get(`/repos/owner/app/compare/${base}...${head}`).reply(200, { files: [] });
  expect((await deliver(JSON.stringify(event, null, 2), { "x-github-event": "pull_request" })).status).toBe(200);
  expect(github.isDone()).toBe(true);
});
test("only the configured webhook path can dispatch events", async () => {
  expect((await deliver(JSON.stringify(push), {}, "/wrong-path")).status).toBe(404);
});
