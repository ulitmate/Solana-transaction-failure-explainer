// Classifier: which instruction failed, which PROGRAM failed, and what state every step ended in.
//
// The gap this closes: `{"InstructionError":[2,{"Custom":6001}]}` names the TOP-LEVEL index only.
// When the failure happened inside a CPI, the code belongs to the INNER program — and codes like
// 1, 2, 6000 exist in nearly every program, so mis-attribution produces confidently wrong answers.
//
// Rule: the failing program is the deepest failing log frame — the FIRST `Program <id> failed:`
// line (every ancestor emits one too). Cross-checked against stackHeight structure; on
// disagreement we refuse to name a program and surface raw evidence instead.

import type { CpiTree, StepNode } from "./cpiTree";
import { findPath, walkTree } from "./cpiTree";
import type { AnchorErrorInfo, LogFrame, LogWalk } from "./logs";
import { PRECOMPILE_IDS, programLabel } from "./programNames";
import type { GetTransactionResult, InstructionErrorDetail, TransactionErr } from "./types";

export type CrossCheck = "confirmed" | "disagreement" | "err_only" | "logs_only" | "not_applicable";

export interface FailureAnalysis {
  status: "success" | "failed";
  kind: "none" | "instruction_error" | "transaction_level";
  errRaw: TransactionErr | null;
  /** Compiled top-level index from meta.err — counts every top-level instruction, ComputeBudget included. */
  failingTopIndex?: number;
  instructionErrorDetail?: InstructionErrorDetail;
  customCode?: number;
  customCodeHex?: string;
  /** Only set when identification is trustworthy; refusal to name a program is a feature. */
  failingProgram?: { id: string; label: string; depth: number };
  crossCheck: CrossCheck;
  crossCheckNote?: string;
  anchorError?: AnchorErrorInfo;
  errorText?: string;
  /** Deterministic plain-language one-liner assembled from decoded facts — no model involved. */
  headline: string;
  computeExhausted: boolean;
  logsTruncated: boolean;
  anomalies: string[];
}

export function parseInstructionError(
  err: TransactionErr | null,
): { index: number; detail: InstructionErrorDetail } | undefined {
  if (err && typeof err === "object" && "InstructionError" in err) {
    const v = (err as { InstructionError: unknown }).InstructionError;
    if (Array.isArray(v) && typeof v[0] === "number") {
      return { index: v[0], detail: (v[1] ?? "unknown") as InstructionErrorDetail };
    }
  }
  return undefined;
}

function describeDetail(detail: InstructionErrorDetail): string {
  if (typeof detail === "string") return detail;
  if ("Custom" in detail && typeof detail.Custom === "number") return `Custom(${detail.Custom})`;
  return JSON.stringify(detail);
}

function describeTxLevelErr(err: TransactionErr): string {
  if (typeof err === "string") return err;
  const key = Object.keys(err)[0];
  return key ? `${key} ${JSON.stringify((err as Record<string, unknown>)[key])}` : JSON.stringify(err);
}

const nodeKey = (n: StepNode) => `${n.topIndex}:${n.ordinal}`;

function markSubtree(node: StepNode, state: StepNode["state"]): void {
  node.state = state;
  for (const child of node.children) markSubtree(child, state);
}

export function classifyFailure(
  result: GetTransactionResult,
  tree: CpiTree,
  walk: LogWalk | null,
): FailureAnalysis {
  const anomalies: string[] = [
    ...tree.anomalies.map((a) => `structure: ${a}`),
    ...(walk?.anomalies ?? []).map((a) => `logs: ${a}`),
  ];
  const err = result.meta?.err ?? null;
  if (result.meta == null) anomalies.push("meta missing from RPC response");

  // Precompiles verify before execution and emit NO log frames, so a logged `invoke [1]`
  // ordinal is an index into the NON-precompile instructions only. Reconcile every log-derived
  // top index to the compiled index meta.err speaks in, instead of comparing raw and refusing.
  const loggedToCompiled: number[] = [];
  result.transaction.message.instructions.forEach((ix, i) => {
    if (!PRECOMPILE_IDS.has(ix.programId)) loggedToCompiled.push(i);
  });
  const compiledIndexOf = (f: LogFrame): number | undefined => loggedToCompiled[f.topIndex];
  if (loggedToCompiled.length !== result.transaction.message.instructions.length) {
    anomalies.push("precompile instruction(s) present — they emit no log frames; log indices reconciled to compiled indices");
  }

  // Annotate compute + per-frame error text onto the tree — but first detect sparse-omission
  // DESYNC: if any logged inner frame has no tree node, ordinals inside that instruction are
  // shifted and unreliable, so nothing there may be matched by ordinal (§ caveat).
  const framesByKey = new Map<string, LogFrame>();
  const desyncedTops = new Set<number>();
  if (walk) {
    for (const f of walk.frames) {
      const ci = compiledIndexOf(f);
      if (ci === undefined) {
        anomalies.push(`log frame at logged top index ${f.topIndex} maps to no compiled instruction — log indices unreliable`);
        continue;
      }
      framesByKey.set(`${ci}:${f.invocationOrdinal}`, f);
    }
    const innerNodeKeys = new Set<string>();
    walkTree(tree, (n) => {
      if (n.ordinal > 0) innerNodeKeys.add(nodeKey(n));
    });
    for (const f of walk.frames) {
      const ci = compiledIndexOf(f);
      if (ci !== undefined && f.invocationOrdinal > 0 && !innerNodeKeys.has(`${ci}:${f.invocationOrdinal}`)) {
        desyncedTops.add(ci);
      }
    }
    if (desyncedTops.size > 0) {
      anomalies.push(
        `innerInstructions omitted invoked frame(s) under #${[...desyncedTops].sort((a, b) => a - b).join(", #")} — per-step detail there degraded to log evidence`,
      );
    }
    walkTree(tree, (node) => {
      // Ordinal 0 is the top-level frame itself — it cannot desync, so it keeps its annotation.
      if (node.ordinal > 0 && desyncedTops.has(node.topIndex)) return;
      const f = framesByKey.get(nodeKey(node));
      if (!f) return;
      if (f.consumed !== undefined) node.consumed = f.consumed;
      if (f.budget !== undefined) node.budget = f.budget;
      if (f.failMessage !== undefined) node.errorText = f.failMessage;
    });
  }

  const logsTruncated = walk?.truncated ?? false;
  const computeExhausted = walk?.computeExhausted ?? false;

  // ---- Success ----
  if (err === null) {
    walkTree(tree, (n) => (n.state = "ran"));
    return {
      status: "success",
      kind: "none",
      errRaw: null,
      crossCheck: "not_applicable",
      headline: "Transaction succeeded — every step ran and was committed.",
      computeExhausted,
      logsTruncated,
      anomalies,
    };
  }

  const ie = parseInstructionError(err);

  // ---- Committed transaction-level failure (no single failing instruction) ----
  if (!ie) {
    const text = describeTxLevelErr(err);
    walkTree(tree, (n) => (n.state = "ran_then_undone"));
    return {
      status: "failed",
      kind: "transaction_level",
      errRaw: err,
      errorText: text,
      crossCheck: walk?.failing ? "logs_only" : "not_applicable",
      headline: `Transaction failed at the transaction level — ${text}. Every instruction was rolled back.`,
      computeExhausted,
      logsTruncated,
      anomalies,
    };
  }

  // ---- Instruction error ----
  const failingTopIndex = ie.index;
  const detail = ie.detail;
  const customCode =
    typeof detail === "object" && "Custom" in detail && typeof detail.Custom === "number"
      ? detail.Custom
      : undefined;
  // meta.err itself is exhaustion evidence, alongside the log text.
  const instructionComputeExhausted =
    computeExhausted || (typeof detail === "string" && detail === "ComputationalBudgetExceeded");

  const failingRoot = tree.roots[failingTopIndex];
  if (!failingRoot) {
    anomalies.push(
      `err names instruction #${failingTopIndex} but the message has only ${tree.roots.length} top-level instructions`,
    );
  }

  // States outside the failing instruction never depend on logs.
  tree.roots.forEach((root, i) => {
    if (i < failingTopIndex) markSubtree(root, "ran_then_undone");
    else if (i > failingTopIndex) markSubtree(root, "never_ran");
  });

  // Inside the failing instruction: log outcomes are the evidence.
  // success = ran then undone · failed = on the failing chain · absent = never invoked.
  const failingFrame = walk?.failing;
  const failingFrameCompiled = failingFrame ? compiledIndexOf(failingFrame) : undefined;
  // A failing frame inferred from the deepest OPEN frame under truncated logs is a guess,
  // not evidence — nothing may be confirmed, placed, or blamed on its authority.
  const failingTrustworthy = failingFrame !== undefined && !(walk?.truncated && walk.failingViaFallback);
  if (failingRoot) {
    if (walk && failingFrame && failingTrustworthy && failingFrameCompiled === failingTopIndex && !desyncedTops.has(failingTopIndex)) {
      // Under truncation, a node with no log frame may simply be past the cut — "never ran"
      // is only provable when the log stream is complete.
      markSubtree(failingRoot, walk.truncated ? "unknown" : "never_ran");
      walkTree(tree, (node) => {
        if (node.topIndex !== failingTopIndex) return;
        const f = framesByKey.get(nodeKey(node));
        if (!f) return;
        node.state = f.outcome === "success" ? "ran_then_undone" : f.outcome === "failed" ? "failed" : "unknown";
      });
      const failNode = findPath(tree, failingTopIndex, failingFrame.invocationOrdinal)?.at(-1);
      if (failNode) {
        failNode.failHere = true;
        if (failNode.state === "unknown") failNode.state = "failed";
      } else {
        anomalies.push(
          `failing frame under #${failingFrameCompiled}.${failingFrame.invocationOrdinal} has no innerInstructions entry — the documented omission; failure placed from logs only`,
        );
      }
    } else {
      failingRoot.state = "failed";
      if (failingRoot.children.length === 0 && !walk) failingRoot.failHere = true;
      // Even when inner ordinals are unreliable, the ROOT frame (ordinal 0) cannot desync:
      // if the trustworthy failing frame is the root itself, its marker survives.
      if (
        failingFrame &&
        failingTrustworthy &&
        failingFrameCompiled === failingTopIndex &&
        failingFrame.invocationOrdinal === 0
      ) {
        failingRoot.failHere = true;
      }
      if (failingRoot.children.length > 0) {
        for (const child of failingRoot.children) markSubtree(child, "unknown");
        anomalies.push(`states inside instruction #${failingTopIndex} unknown — no reliable log evidence`);
      } else if (!walk) {
        anomalies.push("no logs returned — failure placed from meta.err alone");
      }
    }
  }

  // §7.5 cross-check: err's top-level index vs the deepest failing log frame's top-level index.
  let crossCheck: CrossCheck;
  let crossCheckNote: string | undefined;
  let failingProgram: FailureAnalysis["failingProgram"];
  if (failingFrame && failingTrustworthy) {
    if (failingFrameCompiled === failingTopIndex) {
      crossCheck = "confirmed";
      if (desyncedTops.has(failingTopIndex)) {
        crossCheckNote =
          "index-level check only — innerInstructions under this instruction are incomplete, so the structural cross-check was unavailable";
      }
      failingProgram = {
        id: failingFrame.programId,
        label: programLabel(failingFrame.programId),
        depth: failingFrame.height,
      };
    } else {
      crossCheck = "disagreement";
      crossCheckNote =
        `meta.err names top-level instruction #${failingTopIndex}, but the first failing log frame maps to ` +
        `#${failingFrameCompiled ?? "?"} (${programLabel(failingFrame.programId)}). Refusing to name a failing program — raw evidence below.`;
    }
  } else {
    crossCheck = "err_only";
    crossCheckNote = failingFrame
      ? "logs truncated before a definitive `failed:` line — the deepest open frame is a guess; refusing to name a failing program"
      : walk
        ? logsTruncated
          ? "logs truncated before any failing frame — failing program cannot be identified from logs"
          : "no failing frame found in logs — failing program identified from meta.err only"
        : "no logs available — failing program cannot be identified beyond the top-level instruction";
    if (
      failingRoot &&
      failingRoot.children.length === 0 &&
      tree.innerPresentFor.indexOf(failingTopIndex) === -1 &&
      // The tree being silent is NOT proof there was no CPI: the failing entry can be omitted.
      // If any log frame shows a deeper invocation under this instruction, refuse to blame the top.
      !walk?.frames.some((f) => compiledIndexOf(f) === failingTopIndex && f.height > 1)
    ) {
      // No CPIs recorded anywhere for this instruction: the top-level program is the only candidate.
      failingProgram = { id: failingRoot.programId, label: programLabel(failingRoot.programId), depth: 1 };
    }
  }

  // Anchor resolution, log-line first: the failing program already printed name, number and message.
  const anchorError =
    failingFrame && failingTrustworthy
      ? walk?.anchorErrors.filter((a) => failingFrame.logs.includes(a.raw)).at(-1)
      : undefined;

  const errorText = anchorError
    ? `${anchorError.code} (${anchorError.number}): ${anchorError.message}`
    : (failingFrame?.failMessage ?? describeDetail(detail));

  const topLabel = failingRoot ? programLabel(failingRoot.programId) : `#${failingTopIndex}`;
  let headline: string;
  if (instructionComputeExhausted) {
    headline = `Instruction #${failingTopIndex} (${topLabel}) ran out of compute — ${errorText}.`;
  } else if (crossCheck === "disagreement") {
    headline = `Instruction #${failingTopIndex} failed, but the evidence disagrees on where — see raw evidence.`;
  } else if (failingProgram && failingProgram.depth > 1) {
    headline =
      `Instruction #${failingTopIndex} (${topLabel}) failed ${failingProgram.depth - 1} level(s) deep in a CPI — ` +
      `${failingProgram.label} reported: ${errorText}.`;
  } else {
    headline = `Instruction #${failingTopIndex} (${topLabel}) failed: ${errorText}.`;
  }

  return {
    status: "failed",
    kind: "instruction_error",
    errRaw: err,
    failingTopIndex,
    instructionErrorDetail: detail,
    ...(customCode !== undefined ? { customCode, customCodeHex: `0x${customCode.toString(16)}` } : {}),
    ...(failingProgram ? { failingProgram } : {}),
    crossCheck,
    ...(crossCheckNote ? { crossCheckNote } : {}),
    ...(anchorError ? { anchorError } : {}),
    errorText,
    headline,
    computeExhausted: instructionComputeExhausted,
    logsTruncated,
    anomalies,
  };
}
