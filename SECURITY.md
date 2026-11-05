# Security boundaries

The app is a webhook processor, not an agent that executes repository code.

- Trust starts with TLS and a SHA-256 HMAC over bounded, original request bytes.
  Event/delivery headers are not part of GitHub's signature. Runtime schemas
  select the supported actions and project only necessary forwarding fields.
- The GitHub App private key stays in the host. PR installation tokens are minted
  explicitly for one repository with contents read and pull request write; issue
  writes, repository writes, workflow access and Stately project edits are absent.
- Static AST extraction runs in bounded, credential-free worker threads. These
  threads are resource/heap boundaries, not filesystem/network sandboxes. Do not
  add evaluation, dynamic imports of source, or execution of repository scripts.
- Mermaid uses generated IDs and encoded labels. No source-derived URLs, context
  values, action bodies, external thumbnails or rendering-service requests appear
  in comments. Static previews do not establish application correctness.
- The app never deletes comments or modifies existing discussions. Before posting
  it rechecks the current open PR head. Markers are trusted only on this app's bot
  comments. A bounded warm-instance cache suppresses identical signed bodies,
  including replays with changed delivery IDs; it is not distributed storage.
- Cross-instance races, replay beyond the cache window, and delivery/response loss
  are possible. Registry must retain its own durable delivery/SHA deduplication,
  pairing/installation checks, source consent and job lease/revocation controls.
- Neither logs nor HTTP failures serialize SDK errors, request objects, source
  payloads, credentials or validation inputs. Failed processing logs a delivery ID
  for correlation. Disable outbound body/header logging in hosting integrations.
- Dependency scripts are disabled except esbuild's binary installer. CI uses
  read-only repository permissions for tests, pinned actions, a frozen lockfile,
  dependency audit and CodeQL. Dependency/update scanners are evidence, not a
  guarantee that the app or all transitive dependencies are vulnerability-free.

## Operational controls

Keep production forwarding disabled until coordinated backend/UI rollout. Store
keys in the host's secret store, install on selected repositories, rotate keys and
webhook secrets together, and remove unused live app grants/subscriptions. Rate
limits/WAF rules, GitHub IP allow lists, deployment access, secret rotation and
missed-delivery recovery remain operator responsibilities. No live settings,
permissions or secrets are changed by this code update.

Use Stately's private support channel for suspected credential exposure or
vulnerabilities. Do not include real keys or private source in public issues.
