# txwhy

Paste a failed Solana transaction signature. Get back **why it failed** — in plain language, with a picture.

> **Status:** working decoder spike · five real mainnet failure fixtures · reusable failure harvester · offline test suite + CI.
> The illustrated failure map, the open error corpus, and the grounded explanation layer are the [roadmap](#roadmap).

## The problem

A Solana transaction is atomic: several instructions sealed together, touching several programs, each of which may call others. Everything succeeds, or everything is rolled back. When it fails, this is the entirety of what a developer is told:

```
Error: custom program error: 0x1771
```

Which instruction? Which of the five programs involved? How deep in the call chain? Did the earlier steps run? The answers exist — failed transactions return **full data** over RPC — but today the developer hunts through raw logs, three projects' documentation, and chat rooms. Explorers **show** all of it. Nothing **explains** any of it.

| What exists today | What is missing |
|---|---|
| Shows what is inside the transaction | **Why** it failed, in plain words |
| Shows the raw log text | **Where** it failed, as a picture |
| Decodes the technical detail | **What to check next** |

The second column is this project.

## What the decoder already does

Real output, from a real mainnet failure committed as a fixture in this repo (`pnpm spike --fixture fixtures/deep-cpi/2CyCZ…kUV3.json`):

```
signature         2CyCZ3rVt8jdmQDgJrDTY42y1RffAJ4W3DeYwY429PZk9KBkC8sSdnECjMStgdxuwvbCgNboT2v7hciRh1LvkUV3
slot              442,373,519 · 2026-08-28T15:54:35.000Z · v0 tx
status            FAILED
error             {"InstructionError":[5,{"Custom":14}]}
fee               0.000105 SOL (charged despite the failure) · 110,337 CU consumed

why               Instruction #5 (Jupiter Aggregator v6) failed 1 level(s) deep in a CPI — QuaN…bBDv reported: custom program error: 0xe.

#0 ↩ Compute Budget  (ran, then undone)
#1 ↩ Compute Budget  (ran, then undone)
#2 ↩ Associated Token Account — createIdempotent · 7,338 CU  (ran, then undone)
#3 ↩ Associated Token Account — createIdempotent · 4,357 CU  (ran, then undone)
#4 ↩ Associated Token Account — createIdempotent · 13,413 CU  (ran, then undone)
   ├─ ↩ SPL Token — getAccountDataSize
   ├─ ↩ System Program — createAccount
   ├─ ↩ SPL Token — initializeImmutableOwner
   └─ ↩ SPL Token — initializeAccount3
#5 ✗ Jupiter Aggregator v6 · 84,929 CU
   ├─ ↩ REAL…Q5N2
   │  ├─ ↩ SPL Token — transferChecked
   │  └─ ↩ SPL Token — transferChecked
   └─ ✗ QuaN…bBDv · 9,987 CU  ◀ FAILED HERE — custom program error: 0xe
#6 – SPL Token — closeAccount  (never ran)
#7 – SPL Token — transfer  (never ran)

   ↩ ran, then undone · ✗ failed · – never ran

failing program   QuaNtZsgYRe5Z9Bk4LZ4cTD9tbkVoyCNf1R2BN9bBDv (QuaN…bBDv) · depth 2
identified via    first `failed:` log frame, cross-checked against stackHeight — CONFIRMED
custom code       14 (hex 0xe)
```

Every element of the eventual illustrated map is already derivable: the steps in order, the nesting, the exact failure point, the **three states** every step ends in — *ran then undone* (it worked, then the failure rolled it back), *failed* (exactly one), *never ran* (not failures; they simply never happened) — and the fee that was charged anyway.

### Why `0xe` stays `0xe` — for now

`meta.err` says `{"InstructionError":[5,{"Custom":14}]}`. The `5` names the **top-level** instruction; code `14` belongs to the program **inside** the CPI — and small codes like 1, 2, 14 exist in nearly every program, so pinning the code on the wrong program produces a real-looking, confidently wrong answer. The decoder identifies the failing program as the **first `failed:` log frame** (every ancestor emits one too as the failure propagates up), cross-checks it against `stackHeight` structure, and **refuses to name a program when the two disagree**.

This program emits no `AnchorError` text and publishes nothing that names code 14 — so the honest output is `0xe`, not a guess. Turning that code into a name, a plain-language meaning, likely causes, and next checks is the job of the **open error corpus**: the roadmap's centrepiece, machine-readable, every entry citing its source, licensed CC0 so any wallet, explorer, or IDE can consume it.

## Try it

```bash
pnpm install
pnpm spike <signature>                      # any mainnet signature, failed or not
pnpm spike --fixture fixtures/deep-cpi/*.json   # offline, no RPC needed
pnpm test                                   # offline test suite
```

Defaults to the public mainnet RPC; set `RPC_URL` (or `--rpc`) for your own endpoint. A signature that returns nothing is disambiguated, not shrugged at: *pruned from this endpoint* (status exists, body gone — use archival) vs *never landed* (no status even searching full history — usually blockhash expiry).

`pnpm harvest` re-runs the fixture harvester: it pages busy programs with `getSignaturesForAddress` (whose per-signature `err` field finds failures without fetching bodies), fetches only hint-matched candidates, and saves a fixture only when the decoder itself confirms the class. It resumes from `fixtures/index.json` and never lets one signature fill two classes.

## Design notes

- **Structure from `stackHeight`, not logs.** `meta.innerInstructions[].stackHeight` is documented, structured, and immune to log truncation. The array is sparse (only instructions that made CPIs appear) and the failing instruction's entry has been observed omitted — both handled, both surfaced as caveats instead of guessed away.
- **Logs are secondary evidence** — per-program compute and error text. The grammar quirks are coded against: `consumed` precedes `success`/`failed`; the compute-exhaustion line `Program failed to complete:` carries **no program id** and is never popped by id; `Log truncated` is real and degrades output honestly.
- **States are evidence, not inference.** Log outcomes (success / failed / never invoked) label every step inside the failing instruction; outside it, position alone is proof.
- **Refusal is a feature.** A debugger that confidently gives wrong diagnoses is worse than no debugger. Every future layer inherits this rule: the explanation will cite corpus entries or say plainly that the code is unrecognised — never a bare guess.

## Field notes from the first harvest (2026-08-28)

- On busy programs' recent history, **51–99% of listed transactions are failures** — failure is the common case on this network, not the edge case.
- Jupiter v6 emits no `AnchorError` line for its errors: `0x1771` is genuinely all the chain says. The name (`SlippageToleranceExceeded`) exists only in source code — exactly what a corpus is for.
- Across ~5,000 scanned failures, **constraint-range (2000–2999) errors never appeared in bot-dominated flow** — bots pass correct accounts by construction. They surface in human-driven flows. Live sampling under-represents the long tail; a useful corpus must be curated, not just harvested.
- The one constraint-range fixture found reports `DeadlineExceeded (2015)` — a **program-defined name on a constraint-range number** (custom error offset). Assuming stock Anchor names by range would have produced a confidently wrong answer; per-program entries win.

## Roadmap

1. **Engine + visual system** — null-disambiguation as a first-class page, hardened decoder and classifier, and the illustrated failure map (a dedicated illustrator replaces this text tree with the picture the project exists for). States stay distinguishable by **shape and weight, not colour alone** — red/green is exactly the pair colourblind developers cannot separate.
2. **The open error corpus** — one JSON entry per error code per program: name, plain-language meaning, common causes, next checks, `source_url` on every entry, `verified`/`inferred` marked honestly. Published as a package, CC0. If the tool is abandoned tomorrow, the corpus stays useful to everyone building on this network.
3. **Grounded explanations + CLI** — retrieval over the corpus feeding a constrained explainer that must cite the entries it used or refuse; raw evidence always shown alongside. Decode-only CLI by default.

Weekly public updates in [`docs/updates`](docs/) once funded work begins.

## Contributing

Early stage — issues and discussion are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md). The corpus contribution guide ships with the corpus itself.

## Licence

Code: [MIT](LICENSE). The error corpus, when it ships, will be **CC0** — attribution appreciated, never required.
