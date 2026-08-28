// Structure from stackHeight, not logs. `meta.innerInstructions[].stackHeight` is a documented
// field: 1 = top level, 2 = first CPI level. Structured and immune to log truncation.
//
// Two caveats coded against here:
//  - `innerInstructions` is SPARSE: only top-level instructions that made CPIs appear (hence `index`).
//  - The failing instruction's entry has been observed omitted on error — assert presence upstream
//    and degrade to log-derived structure honestly (classify.ts flags it).

import type { GetTransactionResult, ParsedInstruction } from "./types";

export type StepState = "ran" | "ran_then_undone" | "failed" | "never_ran" | "unknown";

export interface StepNode {
  instruction: ParsedInstruction;
  programId: string;
  /** Compiled top-level instruction index — the same index `meta.err` reports. Never renumbered. */
  topIndex: number;
  /** 0 = the top-level instruction itself; 1.. = position in that instruction's inner list (execution order). */
  ordinal: number;
  /** 1 = top level, matching stackHeight / invoke [N]. */
  depth: number;
  children: StepNode[];
  state: StepState;
  /** True on the exact frame where execution broke. */
  failHere?: boolean;
  consumed?: number;
  budget?: number;
  errorText?: string;
}

export interface CpiTree {
  roots: StepNode[];
  maxDepth: number;
  /** Top-level indices that have inner instruction sets (sparse-array awareness). */
  innerPresentFor: number[];
  anomalies: string[];
}

export function buildCpiTree(result: GetTransactionResult): CpiTree {
  const topInstructions = result.transaction.message.instructions;
  const innerSets = new Map<number, ParsedInstruction[]>();
  for (const set of result.meta?.innerInstructions ?? []) innerSets.set(set.index, set.instructions);

  const anomalies: string[] = [];
  let maxDepth = topInstructions.length > 0 ? 1 : 0;

  const roots = topInstructions.map((ix, topIndex) => {
    const root: StepNode = {
      instruction: ix,
      programId: ix.programId,
      topIndex,
      ordinal: 0,
      depth: 1,
      children: [],
      state: "unknown",
    };
    const inner = innerSets.get(topIndex);
    if (!inner) return root;

    const stack: StepNode[] = [root];
    inner.forEach((innerIx, k) => {
      let height = innerIx.stackHeight ?? null;
      if (height === null) {
        anomalies.push(`#${topIndex}.${k + 1}: stackHeight missing (old transaction?) — assuming depth 2`);
        height = 2;
      }
      while (stack.length >= height) stack.pop();
      if (stack.length !== height - 1) {
        anomalies.push(`#${topIndex}.${k + 1}: stackHeight ${height} skips levels`);
      }
      const parent = stack[stack.length - 1] ?? root;
      const node: StepNode = {
        instruction: innerIx,
        programId: innerIx.programId,
        topIndex,
        ordinal: k + 1,
        depth: height,
        children: [],
        state: "unknown",
      };
      parent.children.push(node);
      stack.push(node);
      if (height > maxDepth) maxDepth = height;
    });
    return root;
  });

  return {
    roots,
    maxDepth,
    innerPresentFor: [...innerSets.keys()].sort((a, b) => a - b),
    anomalies,
  };
}

export function walkTree(tree: CpiTree, visit: (node: StepNode) => void): void {
  const stack = [...tree.roots].reverse();
  while (stack.length) {
    const node = stack.pop()!;
    visit(node);
    for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]!);
  }
}

/** Path from the top-level root down to the node matching (topIndex, ordinal), or undefined. */
export function findPath(tree: CpiTree, topIndex: number, ordinal: number): StepNode[] | undefined {
  const root = tree.roots[topIndex];
  if (!root) return undefined;
  const path: StepNode[] = [];
  const dfs = (node: StepNode): boolean => {
    path.push(node);
    if (node.ordinal === ordinal) return true;
    for (const child of node.children) if (dfs(child)) return true;
    path.pop();
    return false;
  };
  return dfs(root) ? path : undefined;
}
