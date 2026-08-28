import { buildCpiTree, type CpiTree } from "./cpiTree";
import { classifyFailure, type FailureAnalysis } from "./classify";
import { walkLogs, type LogWalk } from "./logs";
import type { GetTransactionResult } from "./types";

export interface Decoded {
  result: GetTransactionResult;
  tree: CpiTree;
  walk: LogWalk | null;
  analysis: FailureAnalysis;
}

/** Pure function: RPC result in, decoded + classified failure out. No network. */
export function decodeTransaction(result: GetTransactionResult): Decoded {
  const tree = buildCpiTree(result);
  const logs = result.meta?.logMessages;
  const walk = logs && logs.length > 0 ? walkLogs(logs) : null;
  const analysis = classifyFailure(result, tree, walk);
  return { result, tree, walk, analysis };
}
