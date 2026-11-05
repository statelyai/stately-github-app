import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { z } from "zod";
import type { Config } from "./config.js";
import { forwardDocumentationEvent } from "./documentation.js";
import { updatePullRequestDiagrams } from "./pull-requests.js";
import { WebhookError } from "./webhook.js";

const installation = z.object({ id: z.number().int().positive().safe() });
const repository = z.object({
  id: z.number().int().positive().safe(),
  full_name: z
    .string()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}\/[a-zA-Z0-9_.-]{1,100}$/)
    .refine((value) => ![".", ".."].includes(value.split("/")[1] ?? "")),
  default_branch: z.string().min(1).max(1024),
});
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const push = z.object({
  ref: z.string().max(2048),
  after: sha,
  deleted: z.boolean(),
  repository,
  installation: installation.optional(),
});
const lifecycle = z.object({ action: z.string().max(64), installation });
const removal = lifecycle.extend({
  repositories_removed: z
    .array(z.object({ id: z.number().int().positive().safe() }))
    .max(10_000),
});
const pullRequest = z.object({
  action: z.string().max(64),
  number: z.number().int().positive().safe(),
  repository,
  installation,
  pull_request: z.object({ head: z.object({ sha }) }),
});

// No SDK error serialization: request errors can contain authorization and private source.
const quietLog = { debug() {}, info() {}, warn() {}, error() {} };
const githubFetch: typeof fetch = (input, init) => {
  const url = new URL(
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input
        : input.url,
  );
  if (url.origin !== "https://api.github.com")
    throw new Error("Unexpected GitHub API destination");
  return fetch(input, {
    ...init,
    signal: init?.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(8000)])
      : AbortSignal.timeout(8000),
    redirect: "error",
  });
};

export function createApp(
  config: Config,
  fetchImpl: typeof fetch = githubFetch,
) {
  function parse<T>(schema: z.ZodType<T>, value: unknown) {
    const result = schema.safeParse(value);
    if (!result.success) throw new WebhookError(400, "Invalid event payload");
    return result.data;
  }
  return {
    secret: config.WEBHOOK_SECRET,
    async handleEvent(name: string, id: string, payload: unknown) {
      switch (name) {
        case "push": {
          if (!config.STATELY_DOCUMENTATION_WEBHOOK_URL) return;
          const event = parse(push, payload);
          if (
            event.deleted ||
            event.ref !== `refs/heads/${event.repository.default_branch}` ||
            !event.installation
          )
            return;
          await forwardDocumentationEvent(name, id, event, config);
          return;
        }
        case "installation": {
          const event = parse(lifecycle, payload);
          if (event.action === "deleted" || event.action === "suspend")
            await forwardDocumentationEvent(name, id, event, config);
          return;
        }
        case "installation_repositories": {
          const event = parse(lifecycle, payload);
          if (event.action === "removed")
            await forwardDocumentationEvent(
              name,
              id,
              parse(removal, payload),
              config,
            );
          return;
        }
        case "pull_request": {
          const event = parse(pullRequest, payload);
          if (!["opened", "reopened", "synchronize"].includes(event.action))
            return;
          const signal = AbortSignal.timeout(8000);
          const request = {
            fetch: ((input, init) =>
              fetchImpl(input, { ...init, signal })) satisfies typeof fetch,
          };
          const authOptions = {
            appId: config.APP_ID,
            privateKey: config.PRIVATE_KEY,
          };
          const appOctokit = new Octokit({
            authStrategy: createAppAuth,
            auth: authOptions,
            request,
            log: quietLog,
          });
          const auth = createAppAuth({
            ...authOptions,
            request: appOctokit.request,
            log: quietLog,
          });
          // Mint explicitly: auth-app's request hook does not inherit repositoryIds/permissions.
          const { token } = await auth({
            type: "installation",
            installationId: event.installation.id,
            repositoryIds: [event.repository.id],
            permissions: { contents: "read", pull_requests: "write" },
          });
          const octokit = new Octokit({ auth: token, request, log: quietLog });
          const { data: app } = await appOctokit.rest.apps.getAuthenticated();
          if (!app?.slug) throw new Error("Could not identify GitHub App");
          const [owner, repo] = event.repository.full_name.split("/");
          if (!owner || !repo)
            throw new WebhookError(400, "Invalid repository");
          await updatePullRequestDiagrams({
            octokit,
            owner,
            repo,
            repositoryId: event.repository.id,
            pullNumber: event.number,
            headSha: event.pull_request.head.sha,
            botLogin: `${app.slug}[bot]`,
            signal,
          });
          return;
        }
        // Unsubscribed/unknown actions are authenticated and acknowledged without work.
        default:
          return;
      }
    },
  };
}
