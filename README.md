# Stately GitHub App

Private XState diagrams in pull requests, plus authenticated event forwarding for
Stately's managed documentation drafts. This is an API service; it has no web UI.

## Development

<!-- runtime and commands from package.json, .env.example and lib/config.ts -->

Use Node 24 and the pinned pnpm version through Corepack.

```sh
corepack pnpm install --frozen-lockfile
cp .env.example .env
# Configure a development GitHub App and fill in its credentials locally.
corepack pnpm dev
```

`POST /api/webhook` is the only route. Supply `APP_ID`, `PRIVATE_KEY` (RSA PEM,
escaped-newline PEM, or base64 PEM) and a random `WEBHOOK_SECRET` of at least 32
bytes. Empty/weak credentials fail closed. Probot's registration UI, Smee proxy,
`LOG_LEVEL` and `PRIVATE_KEY_PATH` are no longer supported. Use a separate
development app and a trusted HTTPS tunnel when testing real deliveries.

```sh
corepack pnpm typecheck
corepack pnpm test
corepack pnpm audit
corepack pnpm build:vercel
```

Tests run real local HTTP handlers and the production parser worker. Only external
GitHub/Registry transport is mocked; they need no live credentials or AI calls.
CI also builds the deployable function, audits dependencies, and runs CodeQL.
Dependabot checks npm packages and pinned GitHub Actions weekly.

## Pull request diagrams

<!-- PR actions, source/comment budgets and preview semantics from lib/app.ts, lib/pull-requests.ts, lib/parser.ts and lib/diagrams.ts -->

On `opened`, `reopened` and `synchronize`, the app reads the current open PR and
requests a token restricted to that repository: `contents: read` and
`pull_requests: write`. It reads JavaScript/TypeScript at the immutable head SHA,
extracts static XState topology, and posts up to ten inline Mermaid diagrams in
one review. Existing comments and replies are never deleted or rewritten. Bot
identity and persisted markers prevent ordinary redelivery duplicates.

The app no longer puts machine definitions in external image/editor URLs. Context,
action implementations and service code are excluded from previews. Labels are
encoded, not interpolated as Mermaid instructions. GitHub renders the diagram
within the repository's existing access controls.

Previews cover extracted states and state-level static transitions. Root-level transitions, dynamic
expressions, guards, actions, services, history and parallel execution semantics
are not modeled. The extractor retains the XState 4 dependency it requires;
this is not a runtime validator or complete XState 5 conversion tool.

Work is bounded to 300 listed files, 20 candidate source files, 100 KiB per source,
80 states/160 edges per diagram and ten comment pages. Machines outside the
right-side diff, unsupported/oversized machines and files are skipped. Each parser
runs in a thread with an empty environment, no inherited CLI flags, a three-second
deadline and V8 heap/stack limits. Repository code is parsed, never executed.
Threads share OS filesystem/network permissions; this is not an OS sandbox.

PR processing has an eight-second abort budget. A failed/timed-out delivery can be
redelivered from GitHub; no partial pending review is created before the final
head check. Distributed simultaneous deliveries can still race to post a review;
GitHub's review API has no idempotency key. See [security boundaries](SECURITY.md).

## Managed documentation

<!-- forwarded payloads and configuration from lib/app.ts and lib/documentation.ts -->

When enabled, authenticated non-deletion pushes on the default branch and
installation deletion/suspension/repository-removal events are forwarded to
Registry. Only branch/commit and installation/repository identity fields leave
this host. Commit messages, source files and installation credentials do not.
The compact payload is signed again with the shared webhook secret.

Registry owns repository/project pairing, source-reading consent, token creation,
queueing, AI allowance enforcement and separate reviewable documentation drafts.
This host holds no Stately project key and writes no Stately models. End users
install the app on selected repositories, pair it in Stately and commit the
one-time challenge. They do not create CI secrets.

Deploy the coordinated Studio and Viz changes before activation. An unset
`STATELY_DOCUMENTATION_WEBHOOK_URL` disables forwarding. Enabling this host alone
does not enable generation or authorize source processing.

## License

[ISC](LICENSE), original copyright retained.

## Self-hosting

<!-- listener/build/manifest/ingress settings from lib/server.ts, lib/webhook.ts, scripts/build-vercel.mjs, vercel.json and app.yml -->

Run `corepack pnpm build && corepack pnpm start` from this repository's root.
`HOST` defaults to loopback and `PORT` to 3000. Use TLS at the reverse proxy and
keep GitHub SSL verification enabled. Apply deployment-level rate/concurrency
limits; the application's four-request bound is per process, not a global quota.

On Vercel, `vercel.json` uses the Build Output API. `pnpm build:vercel` packages
only the bundled Node 24 handler and parser worker. `.vc-config.json` explicitly
disables body-parsing helpers so the handler receives the original signed bytes.
The existing `/api/webhook` URL is preserved. Builds need no credentials.

The handler bounds actual ingress bytes to 25 MiB, including chunked requests,
with a ten-second absolute body deadline. It requires SHA-256 HMAC over the exact
bytes before UTF-8/JSON parsing, rejects compression and validates event shapes.
Forwarding accepts only operator-configured HTTPS destinations with no URL
credentials/query/fragment, rejects redirects and has a ten-second total deadline.
SDK requests reject redirects and destinations outside `api.github.com`.

**Hosting limits apply first:** Vercel Functions cap request bodies at 4.5 MB;
this host cannot receive larger GitHub deliveries there. Large commit _lists_ are
compacted only after ingress. Check missed deliveries, redeliver failures, and use
a compatible ingress/host if full 25 MiB delivery support is required. GitHub
expects acknowledgement within ten seconds; slow body transfer or a timeout can
exceed that deadline. This service acknowledges completed work synchronously;
it is not a durable ingress queue.

Keep the existing `stately-github` registration, ID, private key and webhook URL.
Before rollout, check the secret satisfies the new minimum; coordinate rotation
across GitHub, this host and Registry if needed. Subscribe to `push` and
`pull_request`. Installation lifecycle/access changes arrive automatically.
`app.yml` supplies new-registration defaults only. Its permissions omit the unused
`issues: write` grant and its events omit `pull_request_review_comment`. Remove
those legacy grants/subscriptions in the live registration as a separate
operational change; this PR does not alter installed app settings.

Set `STATELY_DOCUMENTATION_WEBHOOK_URL` to
`https://stately.ai/registry/api/github/documentation` after Registry is deployed,
migrated and enabled. Registry's `STATELY_GITHUB_WEBHOOK_SECRET` must match this
host's `WEBHOOK_SECRET`. Registry separately needs the existing app ID/private key
for its own repository-scoped reads. No repository or Stately user key is needed.
