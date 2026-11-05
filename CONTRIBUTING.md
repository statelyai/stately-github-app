# Contributing

Use Node 24 and Corepack's pinned pnpm version. See [README](README.md) for setup
and [security boundaries](SECURITY.md) before changing webhook/authentication code.

<!-- contributor verification commands from package.json -->

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm test
corepack pnpm audit
corepack pnpm build:vercel
```

Work on a feature branch. Keep documentation aligned with behavior and add tests
for affected security boundaries. Tests must use synthetic credentials and mock
external GitHub/Registry transport; never exercise production registrations.
Open pull requests ready for review. Follow the [Code of Conduct](CODE_OF_CONDUCT.md).
