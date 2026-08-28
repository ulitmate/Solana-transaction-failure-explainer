import { describe, expect, it } from "vitest";
import { buildCpiTree } from "../src/cpiTree";
import type { GetTransactionResult, ParsedInstruction } from "../src/types";

function ix(programId: string, stackHeight?: number | null): ParsedInstruction {
  return stackHeight === undefined ? { programId } : { programId, stackHeight };
}

function fakeResult(
  tops: string[],
  inner: Record<number, ParsedInstruction[]>,
): GetTransactionResult {
  return {
    slot: 1,
    meta: {
      err: null,
      fee: 5000,
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

describe("buildCpiTree", () => {
  it("nests by stackHeight and keeps execution-order ordinals", () => {
    const tree = buildCpiTree(
      fakeResult(["A", "B"], {
        1: [ix("B2", 2), ix("C", 3), ix("D", 3), ix("B2b", 2)],
      }),
    );
    const rootB = tree.roots[1]!;
    expect(rootB.children.map((c) => c.programId)).toEqual(["B2", "B2b"]);
    expect(rootB.children[0]!.children.map((c) => c.programId)).toEqual(["C", "D"]);
    expect(rootB.children[0]!.children.map((c) => c.ordinal)).toEqual([2, 3]);
    expect(rootB.children[1]!.ordinal).toBe(4);
    expect(tree.maxDepth).toBe(3);
    expect(tree.anomalies).toEqual([]);
  });

  it("treats innerInstructions as sparse — untouched roots stay leaf nodes", () => {
    const tree = buildCpiTree(fakeResult(["A", "B", "C"], { 1: [ix("X", 2)] }));
    expect(tree.roots[0]!.children).toEqual([]);
    expect(tree.roots[2]!.children).toEqual([]);
    expect(tree.innerPresentFor).toEqual([1]);
  });

  it("assumes depth 2 and flags an anomaly when stackHeight is missing", () => {
    const tree = buildCpiTree(fakeResult(["A"], { 0: [ix("X", null)] }));
    expect(tree.roots[0]!.children[0]!.depth).toBe(2);
    expect(tree.anomalies.some((a) => a.includes("stackHeight missing"))).toBe(true);
  });

  it("flags level-skipping stackHeights instead of crashing", () => {
    const tree = buildCpiTree(fakeResult(["A"], { 0: [ix("X", 4)] }));
    expect(tree.anomalies.some((a) => a.includes("skips levels"))).toBe(true);
    expect(tree.roots[0]!.children).toHaveLength(1);
  });

  it("clamps malformed stackHeights (0, negative, 1, fractional) instead of hanging", () => {
    // A stackHeight <= 0 used to spin the pop loop forever — this test hangs if that regresses.
    const tree = buildCpiTree(fakeResult(["A"], { 0: [ix("W", 0), ix("X", -3), ix("Y", 1), ix("Z", 2.5)] }));
    expect(tree.roots[0]!.children).toHaveLength(4);
    expect(tree.roots[0]!.children.every((c) => c.depth === 2)).toBe(true);
    expect(tree.anomalies.filter((a) => a.includes("invalid stackHeight"))).toHaveLength(4);
  });
});
