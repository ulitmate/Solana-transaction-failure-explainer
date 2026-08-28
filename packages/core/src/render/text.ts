// Text serialisation of a decoded failure. The eventual product renders this as an
// illustrated map; the text form is the spike's proof that every element of that map
// (steps, depth, three states, failure point, compute) is already derivable.

import type { CpiTree, StepNode, StepState } from "../cpiTree";
import type { FailureAnalysis } from "../classify";
import type { LogWalk } from "../logs";
import { programLabel, shortAddress } from "../programNames";
import type { GetTransactionResult } from "../types";

const GLYPH: Record<StepState, string> = {
  ran: "✓",
  ran_then_undone: "↩",
  failed: "✗",
  never_ran: "–",
  unknown: "?",
};

const STATE_TEXT: Record<StepState, string> = {
  ran: "ran",
  ran_then_undone: "ran, then undone",
  failed: "failed",
  never_ran: "never ran",
  unknown: "state unknown",
};

const num = (n: number) => n.toLocaleString("en-US");
const sol = (lamports: number) => `${(lamports / 1e9).toFixed(9).replace(/0+$/, "").replace(/\.$/, "")} SOL`;

function instructionLabel(node: StepNode): string {
  const ix = node.instruction;
  const name = programLabel(node.programId);
  const parsedType =
    typeof ix.parsed === "object" && ix.parsed !== null && "type" in ix.parsed ? ix.parsed.type : undefined;
  return parsedType ? `${name} — ${parsedType}` : name;
}

function nodeLine(node: StepNode, prefix: string, isRoot: boolean): string {
  const glyph = GLYPH[node.state];
  const head = isRoot ? `#${node.topIndex} ` : "";
  let line = `${prefix}${head}${glyph} ${instructionLabel(node)}`;
  if (node.consumed !== undefined && (isRoot || node.failHere)) line += ` · ${num(node.consumed)} CU`;
  if (node.failHere) line += `  ◀ FAILED HERE${node.errorText ? ` — ${node.errorText}` : ""}`;
  else if (isRoot && (node.state === "never_ran" || node.state === "ran_then_undone"))
    line += `  (${STATE_TEXT[node.state]})`;
  return line;
}

function renderSubtree(node: StepNode, indent: string, lines: string[]): void {
  node.children.forEach((child, i) => {
    const last = i === node.children.length - 1;
    lines.push(nodeLine(child, `${indent}${last ? "└─ " : "├─ "}`, false));
    renderSubtree(child, `${indent}${last ? "   " : "│  "}`, lines);
  });
}

export function renderTree(tree: CpiTree): string {
  const lines: string[] = [];
  for (const root of tree.roots) {
    lines.push(nodeLine(root, "", true));
    renderSubtree(root, "   ", lines);
  }
  return lines.join("\n");
}

function balanceChanges(result: GetTransactionResult, limit = 3): string[] {
  const meta = result.meta;
  const keys = result.transaction.message.accountKeys;
  if (!meta?.preBalances || !meta.postBalances) return [];
  const deltas = keys
    .map((key, i) => ({ key, delta: (meta.postBalances![i] ?? 0) - (meta.preBalances![i] ?? 0) }))
    .filter((d) => d.delta !== 0)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, limit);
  return deltas.map(
    (d) =>
      `${shortAddress(d.key.pubkey)}${d.key.signer ? " (signer)" : ""}  ${d.delta > 0 ? "+" : "−"}${sol(Math.abs(d.delta))}`,
  );
}

export function renderText(
  result: GetTransactionResult,
  tree: CpiTree,
  walk: LogWalk | null,
  analysis: FailureAnalysis,
): string {
  const out: string[] = [];
  const pad = (label: string) => label.padEnd(18);
  const meta = result.meta;

  const sig = result.transaction.signatures[0] ?? "(unknown)";
  const when = result.blockTime ? new Date(result.blockTime * 1000).toISOString() : "time unknown";
  const version = result.version === undefined || result.version === "legacy" ? "legacy" : `v${result.version}`;

  out.push(`${pad("signature")}${sig}`);
  out.push(`${pad("slot")}${num(result.slot)} · ${when} · ${version} tx`);
  out.push(`${pad("status")}${analysis.status === "failed" ? "FAILED" : "succeeded"}`);
  if (analysis.errRaw !== null) out.push(`${pad("error")}${JSON.stringify(analysis.errRaw)}`);
  if (meta) {
    const cu = meta.computeUnitsConsumed !== undefined ? ` · ${num(meta.computeUnitsConsumed)} CU consumed` : "";
    out.push(`${pad("fee")}${sol(meta.fee)} (charged despite the failure)${cu}`);
  }
  out.push("");
  out.push(`${pad("why")}${analysis.headline}`);
  out.push("");
  out.push(renderTree(tree));
  out.push("");
  out.push("   ↩ ran, then undone · ✗ failed · – never ran");
  out.push("");

  if (analysis.status === "failed" && analysis.kind === "instruction_error") {
    if (analysis.failingProgram) {
      const fp = analysis.failingProgram;
      out.push(`${pad("failing program")}${fp.id}${fp.label !== fp.id ? ` (${fp.label})` : ""} · depth ${fp.depth}`);
    } else {
      out.push(`${pad("failing program")}not identified — refusing to guess`);
    }
    const check =
      analysis.crossCheck === "confirmed"
        ? "first `failed:` log frame, cross-checked against stackHeight — CONFIRMED"
        : analysis.crossCheck.toUpperCase();
    out.push(`${pad("identified via")}${check}`);
    if (analysis.crossCheckNote) out.push(`${pad("")}⚠ ${analysis.crossCheckNote}`);
    if (analysis.anchorError) {
      const a = analysis.anchorError;
      const where = a.file ? ` · thrown in ${a.file}:${a.line}` : a.accountName ? ` · account: ${a.accountName}` : "";
      out.push(`${pad("anchor error")}${a.code} (${a.number}) — "${a.message}"${where} · from the AnchorError log line`);
    }
    if (analysis.customCode !== undefined) {
      out.push(`${pad("custom code")}${analysis.customCode} (hex ${analysis.customCodeHex})`);
    }
  }

  const balances = balanceChanges(result);
  if (balances.length) {
    balances.forEach((b, i) => out.push(`${pad(i === 0 ? "balance changes" : "")}${b}`));
  }

  const warnings: string[] = [];
  if (analysis.logsTruncated) warnings.push("logs truncated by the validator — evidence below the cut is unavailable");
  warnings.push(...analysis.anomalies);
  if (warnings.length) {
    out.push("");
    warnings.forEach((w, i) => out.push(`${pad(i === 0 ? "caveats" : "")}⚠ ${w}`));
  }

  return out.join("\n");
}
