// Harvester — a committed tool, not a one-off. Re-run it whenever the validator log
// grammar shifts or new fixture classes are needed.
//
//   pnpm harvest [--rpc <url>] [--max-fetches 80] [--pages 3] [--out fixtures]
//
// Strategy: `getSignaturesForAddress` already returns a per-signature `err`, so failures
// are found WITHOUT fetching bodies. Only promising candidates get a `getTransaction`.
// Every candidate runs through the real decoder (@txwhy/core) — a fixture is only saved
// when the decoder's own classification confirms the class it was harvested for.
//
// Note on fidelity: responses pass through JSON.parse, so integers beyond 2^53 (huge
// lamport balances) would lose precision. Decoding never depends on those; the Stage B
// cache stores raw response text instead.

import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  RpcClient,
  decodeTransaction,
  parseInstructionError,
  sleep,
  type GetTransactionResult,
  type SignatureInfo,
} from "@txwhy/core";

const CLASSES = ["compute-exhausted", "anchor-constraint", "anchor-custom", "spl-token", "deep-cpi"] as const;
type FixtureClass = (typeof CLASSES)[number];

const TOKEN_PROGRAMS = new Set([
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
]);

/** Busy programs whose recent history reliably contains failures of every class. */
const SCAN_PROGRAMS: { name: string; id: string }[] = [
  { name: "Jupiter Aggregator v6", id: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4" },
  { name: "Pump.fun", id: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P" },
  { name: "Meteora DLMM", id: "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo" },
  { name: "Orca Whirlpool", id: "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc" },
  { name: "Raydium AMM v4", id: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8" },
  { name: "Metaplex Token Metadata", id: "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s" },
  // Constraint-range (2000–2999) errors rarely show up in plain swap flows; they live where
  // accounts go stale between cranks — lending, DCA, perps.
  { name: "Drift v2", id: "dRiftyHA798LAtfsFy6iWBSyuZAdKm5irVJU29hHGE" },
  { name: "Jupiter DCA", id: "DCA265Vj8a9CEuX1eb1LWRnDT7uK6q1xMipnNyatn23M" },
  { name: "marginfi v2", id: "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA" },
  { name: "Solend", id: "So1endDq2YkqhipRh3WViPa8hdiSpxWy6z3Z6tMCpAo" },
  // Constraint errors concentrate in HUMAN-driven flows (stale listings, changed authorities),
  // not bot flows — bots pass correct accounts by construction. Marketplaces are the source.
  { name: "Tensor Swap", id: "TSWAPaqyCSx2KABk68Shruf4rp7CxcNi8hAsbdwmHbN" },
  { name: "Magic Eden v2", id: "M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K" },
];

interface Saved {
  cls: FixtureClass;
  signature: string;
  slot: number;
  blockTime: number | null;
  scanProgram: string;
  headline: string;
  /** Used to upgrade deep-cpi to a fixture whose failure sits inside the CPI, not at the top. */
  failDepth: number;
}

/** Cheap pre-filter from the signature listing's `err` — decides whether a body fetch is worth it. */
function errHints(info: SignatureInfo, unfilled: Set<FixtureClass>): FixtureClass[] {
  if (info.err === null) return [];
  const ie = parseInstructionError(info.err);
  if (!ie) return []; // committed tx-level errors are a Stage B fixture class
  const hints = new Set<FixtureClass>();
  const d = ie.detail;
  if (typeof d === "string") {
    if (d === "ProgramFailedToComplete" || d === "ComputationalBudgetExceeded") hints.add("compute-exhausted");
  } else if (typeof d === "object" && "Custom" in d && typeof d.Custom === "number") {
    const c = d.Custom;
    if (c >= 6000) hints.add("anchor-custom");
    if (c >= 2000 && c < 3000) hints.add("anchor-constraint");
    if (c <= 50) hints.add("spl-token"); // SPL Token codes are tiny ints — a hint, the decoder confirms
    hints.add("deep-cpi"); // any custom failure on these programs may sit deep
  }
  return [...hints].filter((h) => unfilled.has(h));
}

/** The decoder is the judge: which classes does this transaction ACTUALLY belong to? */
function confirmClasses(result: GetTransactionResult): { classes: FixtureClass[]; headline: string; failDepth: number } {
  const { tree, analysis } = decodeTransaction(result);
  const classes: FixtureClass[] = [];
  if (analysis.status === "failed" && analysis.kind === "instruction_error") {
    const confirmed = analysis.crossCheck === "confirmed";
    if (analysis.computeExhausted && analysis.failingProgram) classes.push("compute-exhausted");
    if (confirmed && analysis.anchorError) {
      const n = analysis.anchorError.number;
      if (n >= 6000) classes.push("anchor-custom");
      if (n >= 2000 && n < 3000) classes.push("anchor-constraint");
    }
    if (confirmed && analysis.failingProgram && TOKEN_PROGRAMS.has(analysis.failingProgram.id)) classes.push("spl-token");
    if (confirmed && tree.maxDepth >= 3) classes.push("deep-cpi");
  }
  return { classes, headline: analysis.headline, failDepth: analysis.failingProgram?.depth ?? 0 };
}

interface HarvestOpts {
  rpc?: string;
  maxFetches: number;
  perProgram: number;
  pages: number;
  out: string;
}

function parseArgs(): HarvestOpts {
  const args = process.argv.slice(2);
  const opts: HarvestOpts = { maxFetches: 150, perProgram: 30, pages: 3, out: "fixtures" };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--rpc") opts.rpc = args[++i];
    else if (a === "--max-fetches") opts.maxFetches = Number(args[++i]);
    else if (a === "--per-program") opts.perProgram = Number(args[++i]);
    else if (a === "--pages") opts.pages = Number(args[++i]);
    else if (a === "--out") opts.out = args[++i]!;
  }
  return opts;
}

/** Seed from an existing manifest so re-runs only hunt unfilled classes. Delete fixtures/ for a fresh start. */
function loadExisting(out: string): Map<FixtureClass, Saved> {
  const map = new Map<FixtureClass, Saved>();
  try {
    const entries = JSON.parse(readFileSync(path.join(out, "index.json"), "utf8")) as Omit<Saved, "failDepth">[];
    for (const e of entries) map.set(e.cls, { ...e, failDepth: 2 });
  } catch {
    /* no manifest yet */
  }
  return map;
}

async function main(): Promise<void> {
  const opts = parseArgs();
  const rpc = new RpcClient({ url: opts.rpc, minDelayMs: 300 });
  console.log(`harvesting from ${rpc.url}`);

  const saved = loadExisting(opts.out);
  if (saved.size > 0) console.log(`resuming: ${[...saved.keys()].join(", ")} already on disk`);
  const seen = new Set<string>();
  let fetches = 0;

  const unfilled = () => new Set(CLASSES.filter((c) => !saved.has(c)));

  for (const program of SCAN_PROGRAMS) {
    if (unfilled().size === 0) break;
    let before: string | undefined;
    let programFetches = 0;
    for (let page = 0; page < opts.pages; page++) {
      if (unfilled().size === 0 || fetches >= opts.maxFetches || programFetches >= opts.perProgram) break;
      let sigs: SignatureInfo[];
      try {
        sigs = await rpc.getSignaturesForAddress(program.id, { limit: 100, ...(before ? { before } : {}) });
      } catch (e) {
        console.log(`  ${program.name}: listing failed (${(e as Error).message}) — moving on`);
        break;
      }
      if (sigs.length === 0) break;
      before = sigs[sigs.length - 1]!.signature;
      const failed = sigs.filter((s) => s.err !== null);
      console.log(`  ${program.name} page ${page + 1}: ${failed.length}/${sigs.length} failed`);

      for (const info of failed) {
        if (fetches >= opts.maxFetches || programFetches >= opts.perProgram || unfilled().size === 0) break;
        if (seen.has(info.signature)) continue;
        const hints = errHints(info, unfilled());
        // deep-cpi needs an upgrade pass: keep looking for a failure INSIDE the CPI
        const deepSaved = saved.get("deep-cpi");
        const wantsDeepUpgrade = deepSaved !== undefined && deepSaved.failDepth < 2 && hints.includes("deep-cpi");
        if (hints.length === 0 && !wantsDeepUpgrade) continue;
        seen.add(info.signature);

        fetches++;
        programFetches++;
        let result: GetTransactionResult | null;
        try {
          result = await rpc.getTransaction(info.signature);
        } catch (e) {
          console.log(`    fetch failed for ${info.signature.slice(0, 8)}… (${(e as Error).message})`);
          continue;
        }
        if (!result) continue;
        await sleep(150);

        const { classes, headline, failDepth } = confirmClasses(result);
        for (const cls of classes) {
          const existing = saved.get(cls);
          const better = cls === "deep-cpi" && existing && failDepth >= 2 && existing.failDepth < 2;
          if (existing && !better) continue;
          // one signature never fills two slots — the five fixtures must be five real transactions
          if ([...saved.values()].some((s) => s.cls !== cls && s.signature === info.signature)) continue;
          const dir = path.join(opts.out, cls);
          if (existing) {
            try {
              unlinkSync(path.join(dir, `${existing.signature}.json`));
            } catch {
              /* already gone */
            }
          }
          const entry: Saved = {
            cls,
            signature: info.signature,
            slot: result.slot,
            blockTime: result.blockTime ?? null,
            scanProgram: program.name,
            headline,
            failDepth,
          };
          saved.set(cls, entry);
          mkdirSync(dir, { recursive: true });
          writeFileSync(
            path.join(dir, `${info.signature}.json`),
            JSON.stringify(
              {
                signature: info.signature,
                class: cls,
                harvestedAt: new Date().toISOString(),
                scanProgram: program.name,
                headline,
                response: result,
              },
              null,
              2,
            ),
          );
          console.log(`    ✔ ${cls}${better ? " (upgraded: failure now inside the CPI)" : ""}: ${info.signature.slice(0, 12)}… — ${headline}`);
        }
      }
    }
  }

  const manifest = [...saved.values()]
    .sort((a, b) => CLASSES.indexOf(a.cls) - CLASSES.indexOf(b.cls))
    .map(({ failDepth: _fd, ...rest }) => rest);
  mkdirSync(opts.out, { recursive: true });
  writeFileSync(path.join(opts.out, "index.json"), JSON.stringify(manifest, null, 2));

  console.log(`\n${saved.size}/${CLASSES.length} classes filled after ${fetches} body fetches`);
  for (const cls of CLASSES) {
    const s = saved.get(cls);
    console.log(`  ${s ? "✔" : "✘"} ${cls}${s ? ` — ${s.signature.slice(0, 12)}… (via ${s.scanProgram})` : ""}`);
  }
  if (saved.size < CLASSES.length) {
    console.log("\nunfilled classes remain — re-run with --pages/--max-fetches raised, or scan later:");
    console.log("failure mixes shift with market activity; compute-exhausted appears in bursts.");
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
