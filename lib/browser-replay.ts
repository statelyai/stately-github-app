import type { IncomingMessage, ServerResponse } from "node:http";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import { readBody, WebhookError } from "./webhook.js";

export const REPLAY_PATH = "/api/webhook?browser-replay";
const issuer = "https://token.actions.githubusercontent.com";
const audience = "stately-viz-browser-replay";
const keys = createRemoteJWKSet(new URL(issuer + "/.well-known/jwks"), { timeoutDuration: 4_000 });
const number = z.number().int().positive().safe();
const decimal = z.string().regex(/^[1-9][0-9]{0,15}$/);
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const verdict = z.enum(["pass", "fail", "inconclusive"]);
const receipt = z.object({
  pullNumber: number,
  baseSha: sha,
  headSha: sha,
  artifactId: decimal,
  scenario: z.literal("resize-grip-reset"),
  base: verdict,
  head: verdict,
}).strict();
const claims = z.object({
  repository: z.literal("statelyai/viz"),
  repository_id: decimal,
  event_name: z.literal("pull_request_target"),
  runner_environment: z.literal("github-hosted"),
  workflow_ref: z.literal("statelyai/viz/.github/workflows/viz-browser-replay.yml@refs/heads/main"),
  run_id: decimal,
  run_attempt: decimal,
  actor: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/),
});

export type ReplayReceipt = z.infer<typeof receipt> & {
  runId: string;
  runAttempt: string;
};

export function regressionUrl(replay: ReplayReceipt | undefined) {
  if (replay?.base !== "pass" || replay.head !== "fail") return;
  return "https://github.com/statelyai/viz/actions/runs/" +
    replay.runId + "/artifacts/" + replay.artifactId;
}

export function replayAlreadyReported(body: string, replay: ReplayReceipt | undefined) {
  if (!replay) return true;
  const seen = /^<!-- stately-browser-replay:([0-9]+):([0-9]+) -->$/m.exec(body);
  if (!seen?.[1] || !seen[2]) return false;
  return BigInt(seen[1]) > BigInt(replay.runId) ||
    (seen[1] === replay.runId && BigInt(seen[2]) >= BigInt(replay.runAttempt));
}

export async function receiveReplay(
  request: IncomingMessage,
  response: ServerResponse,
  repositoryId: string,
  publish: (replay: ReplayReceipt, username: string) => Promise<void>,
) {
  response.setHeader("Cache-Control", "no-store");
  const send = (status: number) => { response.statusCode = status; response.end(); };
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    send(405);
    return;
  }
  const bearer = /^Bearer ([A-Za-z0-9._-]{1,6000})$/.exec(request.headers.authorization ?? "")?.[1];
  if (!bearer) { send(401); return; }
  let identity;
  try {
    const token = await jwtVerify(bearer, keys, { issuer, audience, algorithms: ["RS256"], maxTokenAge: "5m" });
    identity = claims.parse(token.payload);
    if (identity.repository_id !== repositoryId) { send(403); return; }
  } catch {
    send(401);
    return;
  }
  let run;
  try {
    run = receipt.parse(JSON.parse((await readBody(request, 5_000, 2048)).toString("utf8")));
  } catch (error) {
    send(error instanceof WebhookError ? error.status : 400);
    return;
  }
  try {
    await publish({ ...run, runId: identity.run_id, runAttempt: identity.run_attempt }, identity.actor);
    send(204);
  } catch (error) {
    if (error instanceof WebhookError && error.status === 503) {
      response.setHeader("Retry-After", "1");
      send(503);
      return;
    }
    console.error(JSON.stringify({ event: "browser_replay_publish_failed", runId: identity.run_id }));
    send(502);
  }
}
