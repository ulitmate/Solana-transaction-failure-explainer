## What & why

<!-- One or two sentences. Link the issue if one exists. -->

## Checklist

- [ ] `pnpm test` passes **offline** — no test touches the network
- [ ] Decoder behaviour changes come with evidence: a harvested fixture (`pnpm harvest`) or a synthetic-log unit test
- [ ] Output stays honest: uncertainty is surfaced (caveats/refusal), never guessed away
- [ ] No secrets: no RPC URLs with embedded keys, no keypairs, no `.env` contents
