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

const frameKey = (f: { topIndex: number; invocationOrdinal: number }) => `${f.topIndex}:${f.invocationOrdinal}`;
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

  // Annotate compute + per-frame error text onto the tree, and detect sparse omissions (§ caveat).
  const framesByKey = new Map<string, LogFrame>();
  if (walk) {
    for (const f of walk.frames) framesByKey.set(frameKey(f), f);
    walkTree(tree, (node) => {
      const f = framesByKey.get(nodeKey(node));
      if (!f) return;
      if (f.consumed !== undefined) node.consumed = f.consumed;
      if (f.budget !== undefined) node.budget = f.budget;
      if (f.failMessage !== undefined) node.errorText = f.failMessage;
    });
    const innerNodeKeys = new Set<string>();
    walkTree(tree, (n) => {
      if (n.ordinal > 0) innerNodeKeys.add(nodeKey(n));
    });
    const missing = walk.frames.filter((f) => f.invocationOrdinal > 0 && !innerNodeKeys.has(frameKey(f)));
    if (missing.length > 0 && !walk.truncated) {
      anomalies.push(
        `innerInstructions omitted ${missing.length} invoked frame(s) (e.g. #${missing[0]!.topIndex}.${missing[0]!.invocationOrdinal}) — structure degraded to log evidence`,
      );
    }
  }
  if (result.transaction.message.instructions.some((ix) => PRECOMPILE_IDS.has(ix.programId))) {
    anomalies.push("precompile instruction(s) present — they emit no log frames, so log-derived indices can shift");
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
  if (failingRoot) {
    if (walk && failingFrame && failingFrame.topIndex === failingTopIndex) {
      markSubtree(failingRoot, "never_ran");
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
          `failing frame #${failingFrame.topIndex}.${failingFrame.invocationOrdinal} has no innerInstructions entry — the documented omission; failure placed from logs only`,
        );
      }
    } else {
      failingRoot.state = "failed";
      if (failingRoot.children.length === 0 && !walk) failingRoot.failHere = true;
      if (failingRoot.children.length > 0) {
        for (const child of failingRoot.children) markSubtree(child, "unknown");
        anomalies.push(`states inside instruction #${failingTopIndex} unknown — no usable log evidence`);
      } else if (!walk) {
        anomalies.push("no logs returned — failure placed from meta.err alone");
      }
    }
  }

  // §7.5 cross-check: err's top-level index vs the deepest failing log frame's top-level index.
  let crossCheck: CrossCheck;
  let crossCheckNote: string | undefined;
  let failingProgram: FailureAnalysis["failingProgram"];
  if (failingFrame) {
    if (failingFrame.topIndex === failingTopIndex) {
      crossCheck = "confirmed";
      failingProgram = {
        id: failingFrame.programId,
        label: programLabel(failingFrame.programId),
        depth: failingFrame.height,
      };
    } else {
      crossCheck = "disagreement";
      crossCheckNote =
        `meta.err names top-level instruction #${failingTopIndex}, but the first failing log frame sits under ` +
        `#${failingFrame.topIndex} (${programLabel(failingFrame.programId)}). Refusing to name a failing program — raw evidence below.`;
    }
  } else {
    crossCheck = "err_only";
    crossCheckNote = walk
      ? logsTruncated
        ? "logs truncated before any failing frame — failing program cannot be identified from logs"
        : "no failing frame found in logs — failing program identified from meta.err only"
      : "no logs available — failing program cannot be identified beyond the top-level instruction";
    if (failingRoot && failingRoot.children.length === 0 && tree.innerPresentFor.indexOf(failingTopIndex) === -1) {
      // No CPIs recorded for this instruction: the top-level program itself is the only candidate.
      failingProgram = { id: failingRoot.programId, label: programLabel(failingRoot.programId), depth: 1 };
    }
  }

  // Anchor resolution, log-line first: the failing program already printed name, number and message.
  const anchorError = failingFrame
    ? walk?.anchorErrors.filter((a) => failingFrame.logs.includes(a.raw)).at(-1)
    : undefined;

  const errorText = anchorError
    ? `${anchorError.code} (${anchorError.number}): ${anchorError.message}`
    : (failingFrame?.failMessage ?? describeDetail(detail));

  const topLabel = failingRoot ? programLabel(failingRoot.programId) : `#${failingTopIndex}`;
  let headline: string;
  if (computeExhausted) {
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
    computeExhausted,
    logsTruncated,
    anomalies,
  };
}
