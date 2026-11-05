# stately-github-app

> A GitHub App built with [Probot](https://github.com/probot/probot) that An app for visualising XState machines in GitHub

## Setup

<!-- runtime, install and development commands from package.json -->

Use Node 22 or newer.

```sh
# Install dependencies
corepack yarn install --frozen-lockfile

# Run the bot
corepack yarn dev
```

## Contributing

If you have suggestions for how stately-github-app could be improved, or want to report a bug, open an issue! We'd love all and any contributions.

For more, check out the [Contributing Guide](CONTRIBUTING.md).

## License

[ISC](LICENSE) © 2021 Matt Pocock <mattpocockvoice@gmail.com>

## Managed documentation

<!-- event forwarding and configuration from lib/documentation.ts, lib/webhook.ts, lib/app.ts, pages/api/webhook.ts, and app.yml -->

The existing `stately-github` registration can also maintain application
feature documentation. After Probot verifies a GitHub event, this host forwards
non-deletion pushes on the default branch, installation deletion/suspension and
repository-removal events to Registry. Push forwarding contains only the branch,
commit and installation/repository identity fields; commit messages and other
unused payload data are omitted. Large commit lists do not enlarge the forwarded
message beyond Registry's one-megabyte ingestion bound.
Registry pairs repositories to projects, queues generation and stores separate
reviewable drafts. This host receives no Stately project key and performs no
Stately model writes. PR visualizations keep their existing handler.

Documentation reads use a one-repository installation token with `contents: read`,
minted by Registry. The existing registration also grants issue/pull request writes
for its earlier features; reusing that app does not remove those grants.

For the connection, queue, permission checks and draft viewer, deploy the matching
Studio and Viz changes. End users install the app on selected repositories, create
pairing instructions in Stately and commit the one-time challenge to their default
branch. They do not create CI secrets.

## Self-hosting

Keep the existing registration, key and webhook URL. Subscribe it to `push` while
retaining its PR subscriptions. GitHub sends installation lifecycle and repository
access changes automatically; those are not manual event subscriptions. `app.yml`
is only a manifest for new registrations and does not change an installed app.

Set `STATELY_DOCUMENTATION_WEBHOOK_URL` to the deployed Registry
`https://stately.ai/registry/api/github/documentation` endpoint. Its
`STATELY_GITHUB_WEBHOOK_SECRET` must equal this host's existing `WEBHOOK_SECRET`.
Registry also needs the same registration's app ID and private key for source reads.
Use a trusted HTTPS endpoint with no query string; redirects are rejected. An unset
forwarding URL disables documentation forwarding. Registry must be deployed,
migrated and enabled before this URL and the app's push subscription are activated.
The HTTP route enforces a 25 MiB limit on bytes actually read, including chunked
requests, and rejects invalid UTF-8. It verifies the exact signed string using
Probot before parsing JSON and dispatching the event. The legacy middleware path
bypass patch is removed; `/api/webhook` is the single configured entry point.
Host/proxy limits can be lower than this application bound. Production webhook
delivery must be checked against those limits during activation.
No live app settings or credentials are changed by this repository update.
