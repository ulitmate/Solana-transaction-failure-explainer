# Contributing

txwhy is at the working-spike stage. While the foundations are moving fast:

- **Issues and discussion are very welcome** — especially real failed signatures the decoder
  gets wrong or refuses. A signature plus what you expected is a perfect issue.
- **Pull requests are reviewed by the maintainer** before anything lands; nothing merges
  without review. Please open an issue first for anything larger than a small fix, so the
  work isn't wasted if the direction differs.
- **Tests are offline.** If you touch the decoder, `pnpm test` must pass without network
  access; new behaviour needs a fixture (see `pnpm harvest`) or a synthetic-log unit test.

The error corpus — the project's durable deliverable — will ship with its own contribution
guide, JSON schema, and CI validation. Until that lands, corpus entries aren't being accepted,
so nobody's careful work sits in limbo.

## Conduct and security

Everyone participating is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
Security problems go through [private vulnerability reporting](SECURITY.md), never public
issues. Never include secrets in a contribution: no RPC URLs with embedded API keys, no
keypairs, no `.env` contents (`.env.example` shows the shape).
