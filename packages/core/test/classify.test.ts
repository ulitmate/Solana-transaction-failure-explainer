// Regression tests for the classifier's honesty guarantees, pinned by adversarial review:
// precompile index reconciliation, sparse-omission desync, and the refuse-don't-guess fallback.

import { describe, expect, it } from "vitest";
import { decodeTransaction } from "../src/decode";
import { walkTree, type StepNode } from "../src/cpiTree";
import type { GetTransactionResult, ParsedInstruction, TransactionErr } from "../src/types";

const ED25519 = "Ed25519SigVerify111111111111111111111111111";
const ROUTER = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const OTHER = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc";

function ix(programId: string, stackHeight: number): ParsedInstruction {
  return { programId, stackHeight };
}

function fakeTx(
  tops: string[],
  inner: Record<number, ParsedInstruction[]>,
  logMessages: string[],
  err: TransactionErr | null,
): GetTransactionResult {
  return {
    slot: 1,
    meta: {
      err,
      fee: 5000,
      logMessages,
      innerInstructions: Object.entries(inner).map(([index, instructions]) => ({
        index: Number(index),
        instructions,
      })),
    },
    transaction: {
      signatures: ["sig"],
      message: { accountKeys: [], instructions: tops.map((p) => ix(p, 1)) },
    },
  };
}

function collect(decodedTree: Parameters<typeof walkTree>[0]): StepNode[] {
  const nodes: StepNode[] = [];
  walkTree(decodedTree, (n) => nodes.push(n));
  return nodes;
}

describe("classifyFailure", () => {
  it("reconciles log indices across precompile instructions instead of refusing", () => {
    // #0 is a precompile (no log frames at all); #1 fails. Raw log topIndex would be 0.
    const { tree, analysis } = decodeTransaction(
      fakeTx(
        [ED25519, ROUTER],
        {},
        [
          `Program ${ROUTER} invoke [1]`,
          `Program ${ROUTER} consumed 500 of 200000 compute units`,
          `Program ${ROUTER} failed: custom program error: 0x1`,
        ],
        { InstructionError: [1, { Custom: 1 }] },
      ),
    );
    expect(analysis.crossCheck).toBe("confirmed");
    expect(analysis.failingProgram?.id).toBe(ROUTER);
    // the precompile node must not inherit the failing program's compute
    expect(tree.roots[0]!.consumed).toBeUndefined();
    expect(tree.roots[1]!.consumed).toBe(500);
    expect(tree.roots[0]!.state).toBe("ran_then_undone");
  });

  it("refuses to blame the top-level program when logs show a deeper frame it cannot place", () => {
    // innerInstructions omitted entirely; logs truncate after a deeper invoke, so the
    // failing frame is unknown — but depth-1 attribution would be provably wrong.
    const { analysis } = decodeTransaction(
      fakeTx(
        [ROUTER],
        {},
        [`Program ${ROUTER} invoke [1]`, `Program ${TOKEN} invoke [2]`, "Log truncated"],
        { InstructionError: [0, { Custom: 1 }] },
      ),
    );
    expect(analysis.crossCheck).toBe("err_only");
    expect(analysis.failingProgram).toBeUndefined();
  });

  it("still claims depth 1 when no evidence of any CPI exists", () => {
    const { analysis } = decodeTransaction(
      fakeTx(
        [ROUTER],
        {},
        [`Program ${ROUTER} invoke [1]`, "Log truncated"],
        { InstructionError: [0, { Custom: 1 }] },
      ),
    );
    expect(analysis.crossCheck).toBe("err_only");
    expect(analysis.failingProgram?.id).toBe(ROUTER);
    expect(analysis.failingProgram?.depth).toBe(1);
  });

  it("refuses per-step states when innerInstructions omit an invoked frame (ordinal desync)", () => {
    // Logs show three inner calls (B ok, C ok, D fails); the tree only recorded B and D.
    // Matching by ordinal would hand C's outcome to D — so nothing inside may be painted.
    const { tree, analysis } = decodeTransaction(
      fakeTx(
        [ROUTER],
        { 0: [ix(TOKEN, 2), ix(OTHER, 2)] },
        [
          `Program ${ROUTER} invoke [1]`,
          `Program ${TOKEN} invoke [2]`,
          `Program ${TOKEN} success`,
          `Program ${TOKEN} invoke [2]`,
          `Program ${TOKEN} success`,
          `Program ${OTHER} invoke [2]`,
          `Program ${OTHER} failed: custom program error: 0xe`,
          `Program ${ROUTER} failed: custom program error: 0xe`,
        ],
        { InstructionError: [0, { Custom: 14 }] },
      ),
    );
    const nodes = collect(tree);
    expect(nodes.some((n) => n.failHere)).toBe(false); // refuse a possibly-wrong marker
    expect(tree.roots[0]!.state).toBe("failed");
    expect(tree.roots[0]!.children.every((c) => c.state === "unknown")).toBe(true);
    expect(analysis.anomalies.some((a) => a.includes("omitted invoked frame"))).toBe(true);
    // naming the failing PROGRAM is still safe — it comes from the failed log line, not ordinals
    expect(analysis.failingProgram?.id).toBe(OTHER);
  });

  it("flags exhaustion from meta.err even when the logs never say so", () => {
    // The failure text carries no exhaustion wording — only meta.err knows.
    const { analysis } = decodeTransaction(
      fakeTx(
        [ROUTER],
        {},
        [`Program ${ROUTER} invoke [1]`, `Program ${ROUTER} failed: Program failed to complete`],
        { InstructionError: [0, "ComputationalBudgetExceeded"] },
      ),
    );
    expect(analysis.computeExhausted).toBe(true);
    expect(analysis.headline).toContain("ran out of compute");
  });

  it("does not mark provably-executed steps never_ran when logs are truncated", () => {
    // innerInstructions record three executed CPIs; logs cut off after the first invoke plus a
    // bare failed-to-complete line. The later steps DID run — "never ran" would be a lie, and
    // the deepest-open-frame guess must not be blessed as the failing program.
    const { tree, analysis } = decodeTransaction(
      fakeTx(
        [ROUTER],
        { 0: [ix(TOKEN, 2), ix(OTHER, 2), ix(TOKEN, 2)] },
        [
          `Program ${ROUTER} invoke [1]`,
          `Program ${TOKEN} invoke [2]`,
          "Program failed to complete: exceeded CUs meter at BPF instruction",
          "Log truncated",
        ],
        { InstructionError: [0, "ComputationalBudgetExceeded"] },
      ),
    );
    const nodes = collect(tree);
    expect(nodes.every((n) => n.state !== "never_ran")).toBe(true);
    expect(nodes.some((n) => n.failHere)).toBe(false);
    expect(analysis.failingProgram).toBeUndefined();
    expect(analysis.crossCheck).toBe("err_only");
    expect(analysis.crossCheckNote).toContain("guess");
  });

  it("keeps the root failure marker and CU when inner entries desync but the root itself failed", () => {
    // Logs show two inner calls; the tree recorded only one — inner ordinals are unreliable,
    // but ordinal 0 (the root frame) cannot desync, so its CU and marker must survive.
    const { tree, analysis } = decodeTransaction(
      fakeTx(
        [ROUTER],
        { 0: [ix(TOKEN, 2)] },
        [
          `Program ${ROUTER} invoke [1]`,
          `Program ${TOKEN} invoke [2]`,
          `Program ${TOKEN} success`,
          `Program ${OTHER} invoke [2]`,
          `Program ${OTHER} success`,
          `Program ${ROUTER} consumed 900 of 200000 compute units`,
          `Program ${ROUTER} failed: custom program error: 0x1771`,
        ],
        { InstructionError: [0, { Custom: 6001 }] },
      ),
    );
    expect(tree.roots[0]!.failHere).toBe(true);
    expect(tree.roots[0]!.consumed).toBe(900);
    expect(tree.roots[0]!.children.every((c) => c.state === "unknown")).toBe(true);
    expect(analysis.failingProgram?.id).toBe(ROUTER);
    expect(analysis.crossCheck).toBe("confirmed");
    expect(analysis.crossCheckNote).toContain("index-level");
  });
});
