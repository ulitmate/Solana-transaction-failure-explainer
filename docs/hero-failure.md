# The hero failure — illustration handoff

One real failure, already worked out into plain steps. This is the source material for the single
illustrated failure map. Everything below is decoded fact from the chain, not an invented example.

- Signature: `2CyCZ3rVt8jdmQDgJrDTY42y1RffAJ4W3DeYwY429PZk9KBkC8sSdnECjMStgdxuwvbCgNboT2v7hciRh1LvkUV3`
- On chain: 2026-08-28, slot 442,373,519 · [view on Solscan](https://solscan.io/tx/2CyCZ3rVt8jdmQDgJrDTY42y1RffAJ4W3DeYwY429PZk9KBkC8sSdnECjMStgdxuwvbCgNboT2v7hciRh1LvkUV3)
- Committed fixture: [`fixtures/deep-cpi/…`](../fixtures/deep-cpi) — the decoder's full text output is at the bottom.

## The six ideas, as they appear in this one transaction

| Idea | Plain version | In this transaction |
|---|---|---|
| A box | Everything on the network is a labelled box | The person's wallet; the token boxes being prepared |
| A machine | Code that does things to boxes | Jupiter (route-finder), two exchange machines, the token machine |
| A work order | One command: which machine, which boxes, what to do | Each of the 8 numbered steps below |
| An envelope | Work orders sent together; all succeed or all fail | This whole transaction |
| Nesting | A machine pausing to call another machine | The swap calls an exchange, which calls the token machine |
| A fuel gauge | Every envelope gets fuel; run out and everything fails | 110,337 units burned — visible per step |

## What this transaction tried to do

A person asked Jupiter — a machine that finds the best route for a token swap — to trade one token
for another. The route had two legs: swap on one exchange, then finish on a second exchange.
The envelope contained eight work orders.

## The steps, in plain words

1. **Steps #0–#1 — set the fuel.** Two small work orders setting the fuel price and limit.
   *Ran, then undone.*
2. **Steps #2–#4 — prepare the boxes.** Make sure the token boxes the swap will use exist
   (step #4 actually built one: four small nested steps inside — ask the token machine how big
   the box must be, create it, seal its ownership, initialise it). *All ran, then undone.*
3. **Step #5 — the swap. This is where it broke.**
   - Leg one: Jupiter called the first exchange machine (`REAL…Q5N2`), which moved tokens
     **twice** through the token machine. Both moves worked. *Ran, then undone.*
   - Leg two: Jupiter called the second exchange machine (`QuaN…bBDv`) — and that machine
     said **no**, with its error code 14. **The break. Two levels deep.**
4. **Steps #6–#7 — the cleanup.** Close a temporary box, move the result. *Never ran.*
   Not failures — the envelope rule means they simply never happened.

Because one work order failed, everything already done was rolled back. The person's tokens
never moved — but the network fee (0.000105 SOL) was still charged, because the network did
the work of finding out.

## The three states — all present in this one failure

| State | Meaning | Here |
|---|---|---|
| Ran, then undone | It worked; a later failure rolled it back — it succeeded *and* it did not happen | Steps #0–#4, and leg one of the swap (with its two token moves) |
| Failed | The one step that broke. There is exactly one | Leg two of the swap, two levels deep |
| Never ran | After the break; simply never happened | Steps #6–#7 |

## What the picture must make readable in three seconds

1. **The steps, in order** — eight numbered work orders in one envelope.
2. **The nesting** — the break is not at the top level. The developer is told "instruction #5
   failed"; the truth lives one level further in. Depth must be readable at a glance.
3. **The three states** — distinguished by **shape and weight, not colour alone**. Many
   developers are colourblind, and red/green is exactly the pair they cannot separate.
4. **Exactly one failure point** — everything else is a consequence of it.
5. (Optional, it's the emotional note): the fee was charged anyway.

## The decoder's text rendering of this failure

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
