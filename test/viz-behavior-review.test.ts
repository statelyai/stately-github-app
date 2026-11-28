import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import nock from "nock";
import { createApp } from "../lib/app.js";
import type { ReviewEntry, ReviewInput } from "../lib/behavior-review-model.js";
import { createWebhookHandler } from "../lib/webhook.js";
import { VIZ_REVIEW_LABEL, renderBehaviorComment } from "../lib/viz-behavior-review.js";
import { config, headSha, serve, send, signedHeaders } from "./helpers.js";

const base = "b".repeat(40);
const newer = "c".repeat(40);
const file = "packages/editor/src/View.tsx";
const patch = "@@ -4,1 +4,1 @@\n-oldRoute()\n+openFlow(id)";
const rule = { id: "open", paths: [file], expected: "A summary link opens the named flow." };
const review: ReviewEntry = {
  kind: "change",
  summary: "Open the named flow from the summary.",
  before: [],
  after: ["Follow the summary link", "Named flow opens"],
  evidence: { path: file, line: 4, excerpt: "openFlow(id)" },
};
const event = {
  action: "labeled",
  number: 1,
  label: { name: VIZ_REVIEW_LABEL },
  sender: { login: "reviewer", type: "User" },
  repository: { id: 22, full_name: "statelyai/viz", default_branch: "main" },
  installation: { id: 7 },
  pull_request: { head: { sha: headSha } },
};
const pilotConfig = {
  ...config(),
  STATELY_VIZ_REVIEW_REPOSITORY_ID: "22",
  STATELY_VIZ_REVIEW_MODEL: "synthetic-model",
  OPENAI_API_KEY: "synthetic-key",
};
const marker = "<!-- stately-behavior-review:v1:";
const bot = { login: "stately-github[bot]", type: "Bot" };

function github({ permission = "write", move = false } = {}) {
  const writes: { method: string; body: string }[] = [];
  const comments = [{ id: 10, body: marker, user: { login: "human", type: "User" } }];
  let head = headSha;
  let reads = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    assert.equal(url.origin, "https://api.github.com");
    const json = (data: unknown) => Response.json(data);
    if (url.pathname === "/app/installations/7/access_tokens") {
      assert.deepEqual(await request.json(), {
        repository_ids: [22],
        permissions: { contents: "read", pull_requests: "write" },
      });
      return json({ token: "ghs_synthetic", expires_at: new Date(Date.now() + 3600_000).toISOString() });
    }
    if (url.pathname === "/repos/statelyai/viz/installation") return json({ id: 7 });
    if (url.pathname === "/app") return json({ id: 123, slug: "stately-github" });
    assert.match(url.pathname, /^\/repos\/statelyai\/viz\//);
    if (url.pathname.endsWith("/collaborators/reviewer/permission")) return json({ permission });
    if (url.pathname.endsWith("/pulls/1")) {
      return json({
        state: "open",
        base: { sha: base, repo: { id: 22 } },
        head: { sha: move && ++reads > 1 ? newer : head },
        labels: [{ name: VIZ_REVIEW_LABEL }],
      });
    }
    if (url.pathname.endsWith("/issues/1/comments") && request.method === "GET")
      return json(comments);
    if (url.pathname.endsWith("/issues/1/comments") && request.method === "POST") {
      const { body } = await request.json();
      writes.push({ method: "POST", body });
      comments.push({ id: 11, body, user: bot });
      return json({ id: 11 });
    }
    if (url.pathname.endsWith("/issues/comments/11") && request.method === "PATCH") {
      const { body } = await request.json();
      writes.push({ method: "PATCH", body });
      comments[1] = { id: 11, body, user: bot };
      return json({ id: 11 });
    }
    if (url.pathname.endsWith("/compare/" + base + "..." + head)) {
      return json({ files: [{ filename: file, patch }] });
    }
    if (decodeURIComponent(url.pathname).endsWith("/contents/.github/stately-behavior-review.json")) {
      assert.equal(url.searchParams.get("ref"), base);
      const bytes = Buffer.from(JSON.stringify({ version: 1, rules: [rule, {
        ...rule, id: "unrelated", paths: ["another.ts"],
      }] }));
      return json({ type: "file", encoding: "base64", size: bytes.length, content: bytes.toString("base64") });
    }
    throw new Error("Unexpected GitHub API path: " + request.method + " " + url.pathname);
  };
  return { fetchImpl, writes, advance() { head = newer; } };
}

test("a signed on-demand delivery uses base rules and creates one private linked comment", async () => {
  const api = github();
  const jobs: Promise<void>[] = [];
  const inputs: ReviewInput[] = [];
  const app = createApp(pilotConfig, api.fetchImpl, {
    waitUntil: (work) => jobs.push(work),
    analyze: async (input) => { inputs.push(input); return [review]; },
  });
  const host = await serve(createWebhookHandler(app));
  try {
    const body = JSON.stringify(event);
    const response = await send(host.url, body, signedHeaders(body, "pull_request"));
    assert.equal(response.status, 200, response.body);
    assert.equal(jobs.length, 1);
    await Promise.all(jobs);
    assert.deepEqual(inputs, [{ files: [{ path: file, patch }], rules: [rule] }]);
    assert.equal(api.writes.length, 1);
    assert.match(api.writes[0]!.body, /\[Open the named flow from the summary\.\]\(#user-content-stately-viz-1-bbbbbbbb-aaaaaaaaaaaa-flow-1\)/);
    assert.match(api.writes[0]!.body, /<a name="stately-viz-1-bbbbbbbb-aaaaaaaaaaaa-flow-1"><\/a>/);
    assert.match(api.writes[0]!.body, /flowchart TD/);
    assert.ok(api.writes[0]!.body.includes("/blob/" + headSha + "/" + file + "#L4"));

    await app.handleEvent("pull_request", randomUUID(), event);
    await Promise.all(jobs);
    assert.equal(inputs.length, 1);
    assert.equal(api.writes.length, 1);

    api.advance();
    await app.handleEvent("pull_request", randomUUID(), {
      ...event, pull_request: { head: { sha: newer } },
    });
    await Promise.all(jobs);
    assert.deepEqual(api.writes.map(({ method }) => method), ["POST", "PATCH"]);
    assert.match(api.writes[1]!.body, /stately-viz-1-bbbbbbbb-cccccccccccc-flow-1/);
    assert.doesNotMatch(api.writes[1]!.body, /stately-viz-1-bbbbbbbb-aaaaaaaaaaaa-flow-1/);
  } finally {
    await host.close();
  }
});

test("retains a manual trigger for a new revision while the old review is running", async () => {
  const api = github();
  const firstAnalysis = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  const jobs: Promise<void>[] = [];
  let analyses = 0;
  const app = createApp(pilotConfig, api.fetchImpl, {
    waitUntil: (work) => jobs.push(work),
    analyze: async () => {
      if (++analyses === 1) {
        firstAnalysis.resolve();
        await releaseFirst.promise;
      }
      return [review];
    },
  });
  await app.handleEvent("pull_request", randomUUID(), event);
  try {
    await firstAnalysis.promise;
    api.advance();
    await app.handleEvent("pull_request", randomUUID(), {
      ...event, pull_request: { head: { sha: newer } },
    });
    assert.equal(jobs.length, 2);
    assert.equal(analyses, 1);
  } finally {
    releaseFirst.resolve();
    await Promise.all(jobs);
  }
  assert.equal(analyses, 2);
  assert.equal(api.writes.length, 1);
  assert.equal(api.writes[0]!.method, "POST");
  assert.match(api.writes[0]!.body, /stately-viz-1-bbbbbbbb-cccccccccccc-flow-1/);
});

test("enabled pilot ignores automatic deliveries, other labels, bots, and other repos", async () => {
  const app = createApp(pilotConfig, async () => { throw new Error("Unexpected GitHub call"); });
  for (const input of [
    { ...event, action: "synchronize" },
    { ...event, label: { name: "other" } },
    { ...event, sender: { login: "user", type: "Bot" } },
    { ...event, repository: { ...event.repository, full_name: "another/viz" } },
    { ...event, repository: { ...event.repository, id: 99 } },
  ]) {
    await app.handleEvent("pull_request", randomUUID(), input);
  }
});

test("skips stale, unauthorized, fabricated and risk-only results", async () => {
  for (const option of ["stale", "unauthorized", "fabricated", "risk"] as const) {
    const api = github({ move: option === "stale", permission: option === "unauthorized" ? "read" : "write" });
    const app = createApp(pilotConfig, api.fetchImpl, {
      analyze: async () => {
        assert.notEqual(option, "unauthorized");
        if (option === "fabricated") return [{ ...review, evidence: { ...review.evidence, line: 99 } }];
        if (option === "risk") return [{ ...review, kind: "risk" }];
        return [review];
      },
    });
    await app.handleEvent("pull_request", randomUUID(), event);
    assert.equal(api.writes.length, 0, option);
  }
});

test("rendered prose and diagram labels cannot add links, mentions, markup or a code block", () => {
  const unsafe = "@everyone <img> ```](https://example.com)";
  const body = renderBehaviorComment(1, base, headSha, [
    { ...review, summary: unsafe, after: [unsafe, "Next"] },
  ]);
  assert.ok(!body.includes("@everyone"));
  assert.ok(!body.includes("<img>"));
  const links = [...body.matchAll(/\]\(([^)\n]+)\)/g)].map((match) => match[1]);
  assert.deepEqual(links, [
    "#user-content-stately-viz-1-bbbbbbbb-aaaaaaaaaaaa-flow-1",
    "https://github.com/statelyai/viz/blob/" + headSha + "/" + file + "#L4",
  ]);
  assert.ok(body.includes("#64;everyone"));
});

test("uses the gateway only for a prefixed OpenAI model", async () => {
  const { analyzeBehavior } = await import("../lib/behavior-review-model.js");
  for (const model of ["openai/gpt-5-mini", "gpt-4.1-mini"]) {
    const gateway = model.startsWith("openai/");
    const entries = await analyzeBehavior({ files: [{ path: file, patch }], rules: [rule] }, {
      apiKey: "synthetic-key", model, signal: AbortSignal.timeout(1000),
      fetch: async (input, init) => {
        const request = new Request(input, init);
        assert.equal(request.url, gateway
          ? "https://ai-gateway.vercel.sh/v1/responses"
          : "https://api.openai.com/v1/responses");
        assert.equal(request.headers.get("authorization"), "Bearer synthetic-key");
        const body = await request.json();
        assert.equal(body.model, model);
        assert.equal(body.store, false);
        assert.equal(body.text.format.strict, true);
        assert.match(body.input, /4 \+openFlow\(id\)/);
        return Response.json({ status: "completed", output: [{
          type: "message", content: [{ type: "output_text", text: '{"entries":[]}' }],
        }] });
      },
    });
    assert.deepEqual(entries, []);
  }
});

test("an authenticated browser replay updates one comment and only flags base-pass head-fail", async () => {
  const api = github();
  const issuer = "https://token.actions.githubusercontent.com";
  const audience = "stately-viz-browser-replay";
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  const keyRequest = nock(issuer).get("/.well-known/jwks").reply(200, { keys: [{ ...jwk, kid: "replay-test" }] });
  const app = createApp({ ...pilotConfig, STATELY_VIZ_BROWSER_REPLAY: "1" }, api.fetchImpl, {
    analyze: async () => [
      review,
      { ...review, summary: "Second supported change." },
      { ...review, summary: "Third supported change." },
      { ...review, kind: "risk", summary: "Unverified model warning." },
    ],
  });
  const host = await serve(async (request, response) => {
    assert.equal(await app.handleReplayRequest(request, response), true);
  });
  const baseReceipt = {
    pullNumber: 1, baseSha: base, headSha, artifactId: "15",
    scenario: "resize-grip-reset", base: "pass", head: "fail",
  };
  const deliver = async (attempt: string, body: unknown, workflow = "main") => {
    const authorization = await new SignJWT({
      repository: "statelyai/viz", repository_id: "22", runner_environment: "github-hosted",
      event_name: "pull_request_target", actor: "reviewer", run_id: "123",
      run_attempt: attempt, workflow_ref: "statelyai/viz/.github/workflows/viz-browser-replay.yml@refs/heads/" + workflow,
    }).setProtectedHeader({ alg: "RS256", kid: "replay-test" })
      .setIssuer(issuer).setAudience(audience).setIssuedAt().setExpirationTime("5m").sign(privateKey);
    const response = await fetch(host.url + "?browser-replay", {
      method: "POST", headers: { authorization: "Bearer " + authorization },
      body: JSON.stringify(body),
    });
    return response.status;
  };
  const replayLinks = (body: string | undefined) =>
    [...(body ?? "").matchAll(/^\- \[Double-clicking the resize grip fails to reset the panel width\.\]\(([^)]+)\)$/gm)].map(match => match[1]);
  try {
    await app.handleEvent("pull_request", randomUUID(), event);
    assert.equal(api.writes.length, 0, "Only the replay callback may publish");
    assert.equal(await deliver("1", baseReceipt, "untrusted"), 401);
    assert.equal(await deliver("1", { ...baseReceipt, artifactId: "https://example.com" }), 400);
    assert.equal(await deliver("1", { ...baseReceipt, baseSha: newer }), 204);
    assert.equal(api.writes.length, 0);
    assert.deepEqual(await Promise.all([deliver("1", baseReceipt), deliver("1", baseReceipt)]), [204, 204]);
    assert.equal(api.writes.length, 1);
    assert.deepEqual(replayLinks(api.writes[0]?.body), ["https://github.com/statelyai/viz/actions/runs/123/artifacts/15"]);
    assert.doesNotMatch(api.writes[0]?.body ?? "", /Unverified model warning|Third supported change/);
    assert.equal(api.writes[0]?.body.match(/^- \[/gm)?.length, 3);
    assert.equal(await deliver("1", baseReceipt), 204);
    assert.equal(api.writes.length, 1);
    assert.equal(await deliver("2", { ...baseReceipt, head: "pass" }), 204);
    assert.equal(await deliver("3", { ...baseReceipt, base: "fail" }), 204);
    assert.equal(await deliver("4", { ...baseReceipt, head: "inconclusive" }), 204);
    assert.deepEqual(api.writes.map(write => write.method), ["POST", "PATCH", "PATCH", "PATCH"]);
    for (const write of api.writes.slice(1)) assert.deepEqual(replayLinks(write.body), []);
    assert.equal(await deliver("1", baseReceipt), 204);
    assert.equal(api.writes.length, 4);
    keyRequest.done();
  } finally {
    await host.close();
    nock.cleanAll();
  }
});
