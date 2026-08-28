// The spike: paste a signature, see the failure decoded.
//   pnpm spike <signature> [--rpc <url>]
//   pnpm spike --fixture fixtures/<class>/<sig>.json     (offline, no network)

import { readFileSync } from "node:fs";
import { RpcClient, RpcError } from "../rpc";
import { decodeTransaction } from "../decode";
import { renderText } from "../render/text";
import type { GetTransactionResult } from "../types";

const SIGNATURE_RE = /^[1-9A-HJ-NP-Za-km-z]{80,90}$/;

function usage(): never {
  console.error("usage: pnpm spike <signature> [--rpc <url>]");
  console.error("       pnpm spike --fixture <path-to-fixture.json>");
  process.exit(2);
}

function printDecoded(result: GetTransactionResult): void {
  const { tree, walk, analysis } = decodeTransaction(result);
  console.log(renderText(result, tree, walk, analysis));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let signature: string | undefined;
  let fixture: string | undefined;
  let rpcUrl: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--fixture") fixture = args[++i];
    else if (a === "--rpc") rpcUrl = args[++i];
    else if (a.startsWith("-")) usage();
    else signature = a;
  }

  if (fixture) {
    const parsed = JSON.parse(readFileSync(fixture, "utf8")) as
      | GetTransactionResult
      | { response: GetTransactionResult };
    printDecoded("response" in parsed ? parsed.response : parsed);
    return;
  }

  if (!signature) usage();

  if (!SIGNATURE_RE.test(signature)) {
    console.error("This does not look like a transaction signature (base58, ~87–88 characters).");
    console.error("It cannot exist on chain, so there is nothing to diagnose.");
    process.exit(1);
  }

  const rpc = new RpcClient({ url: rpcUrl, minDelayMs: 100 });
  let result: GetTransactionResult | null;
  try {
    result = await rpc.getTransaction(signature);
  } catch (e) {
    console.error(`RPC error from ${rpc.url}:`);
    console.error(e instanceof RpcError ? `  ${e.message}` : e);
    process.exit(1);
  }

  if (result === null) {
    // "My transaction didn't land" is the most common real failure. Disambiguate, don't shrug.
    const statuses = await rpc.getSignatureStatuses([signature]);
    const status = statuses.value[0] ?? null;
    if (status) {
      console.log(`This transaction IS on chain (slot ${status.slot}, ${status.confirmationStatus ?? "status unknown"}),`);
      console.log("but this RPC endpoint no longer holds its body — it has likely been pruned.");
      console.log("Set RPC_URL to an archival endpoint (Helius / Triton / QuickNode free tiers) and retry.");
    } else {
      console.log("No record of this signature exists, even searching full transaction history.");
      console.log("This transaction never made it into a block. The usual cause: its blockhash expired");
      console.log("(~60–90s) before a leader included it. There is no failure data to decode, because");
      console.log("failure data only exists for transactions that landed.");
    }
    return;
  }

  printDecoded(result);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
