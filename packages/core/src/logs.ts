// Log walk. Logs are SECONDARY evidence: per-program compute and error text.
// Structure comes from stackHeight (cpiTree.ts); the walk cross-checks it.
//
// Grammar (order matters — `consumed` comes BEFORE `success`/`failed`):
//   Program <id> invoke [N]
//   Program log: <msg>
//   Program <id> consumed 1234 of 200000 compute units
//   Program <id> success
//   Program <id> failed: <reason>
//   Program failed to complete: <error>    // compute exhaustion etc. — NO program id, cannot pop by id
//   Program return: <id> <data>
//   Program data: <base64>
//   Log truncated                          // real; degrade honestly, never report a wrong tree

export interface AnchorErrorInfo {
  code: string;
  number: number;
  message: string;
  file?: string;
  line?: number;
  accountName?: string;
  raw: string;
}

export interface LogFrame {
  programId: string;
  /** As logged in `invoke [N]`: 1 = top level. */
  height: number;
  /** 0-based count of `invoke [1]` lines seen — the compiled top-level instruction ordinal. */
  topIndex: number;
  /** 0 = the top-level instruction itself; 1.. = nth inner invocation within that top-level instruction. */
  invocationOrdinal: number;
  consumed?: number;
  budget?: number;
  outcome: "success" | "failed" | "unclosed";
  failMessage?: string;
  /** `Program log:` payloads emitted while this frame was the deepest open frame. */
  logs: string[];
}

export interface LogWalk {
  frames: LogFrame[];
  /**
   * The deepest failing frame = the FIRST `Program <id> failed:` line,
   * since every ancestor emits one too as the failure propagates up.
   */
  failing?: LogFrame;
  /** Bare `Program failed to complete:` line — carries no id; the deepest open frame is the culprit. */
  failedToComplete?: { message: string };
  /** True when `failing` was INFERRED from the deepest open frame rather than closed by a `failed:` line. */
  failingViaFallback: boolean;
  anchorErrors: AnchorErrorInfo[];
  truncated: boolean;
  computeExhausted: boolean;
  anomalies: string[];
}

const RE = {
  invoke: /^Program (\w{32,44}) invoke \[(\d+)\]$/,
  success: /^Program (\w{32,44}) success$/,
  failed: /^Program (\w{32,44}) failed: (.+)$/,
  consumed: /^Program (\w{32,44}) consumed (\d+) of (\d+) compute units$/,
  failedToComplete: /^Program failed to complete: (.+)$/,
  programLog: /^Program log: (.*)$/,
  programData: /^Program data: (.*)$/,
  programReturn: /^Program return: (\w{32,44}) ?(.*)$/,
};

const ANCHOR_RE =
  /^AnchorError (?:thrown in ([^:]+):(\d+)|caused by account: ([\w.]+)|occurred)\. Error Code: ([^.]+)\. Error Number: (\d+)\. Error Message: (.*?)\.?$/;

export function parseAnchorError(logPayload: string): AnchorErrorInfo | undefined {
  const m = ANCHOR_RE.exec(logPayload);
  if (!m) return undefined;
  const [, file, line, accountName, code, number, message] = m;
  return {
    code: code!,
    number: Number(number),
    message: message ?? "",
    ...(file ? { file, line: Number(line) } : {}),
    ...(accountName ? { accountName } : {}),
    raw: logPayload,
  };
}

export function walkLogs(logMessages: string[]): LogWalk {
  const frames: LogFrame[] = [];
  const stack: LogFrame[] = [];
  const anchorErrors: AnchorErrorInfo[] = [];
  const anomalies: string[] = [];
  let topIndex = -1;
  let innerCounter = 0;
  let failing: LogFrame | undefined;
  let failedToComplete: { message: string } | undefined;
  let failedToCompleteFrame: LogFrame | undefined;
  let truncated = false;

  for (const line of logMessages) {
    if (line === "Log truncated") {
      truncated = true;
      continue;
    }
    let m: RegExpExecArray | null;

    if ((m = RE.invoke.exec(line))) {
      const height = Number(m[2]);
      if (height === 1) {
        topIndex++;
        innerCounter = 0;
        if (stack.length > 0) {
          anomalies.push(`top-level invoke while ${stack.length} frame(s) still open`);
          stack.length = 0;
        }
      } else {
        innerCounter++;
      }
      if (height !== stack.length + 1) {
        anomalies.push(`invoke height ${height} at stack depth ${stack.length}`);
      }
      const frame: LogFrame = {
        programId: m[1]!,
        height,
        topIndex,
        invocationOrdinal: height === 1 ? 0 : innerCounter,
        outcome: "unclosed",
        logs: [],
      };
      frames.push(frame);
      stack.push(frame);
      continue;
    }

    if ((m = RE.consumed.exec(line))) {
      // consumed precedes success/failed, so the frame is still open — find deepest open frame by id
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i]!.programId === m[1]) {
          stack[i]!.consumed = Number(m[2]);
          stack[i]!.budget = Number(m[3]);
          break;
        }
      }
      continue;
    }

    if ((m = RE.success.exec(line))) {
      const frame = stack.pop();
      if (!frame || frame.programId !== m[1]) anomalies.push(`success for ${m[1]} did not match the open frame`);
      if (frame) frame.outcome = "success";
      continue;
    }

    if ((m = RE.failed.exec(line))) {
      const frame = stack.pop();
      if (frame) {
        frame.outcome = "failed";
        frame.failMessage = m[2]!;
        if (!failing) failing = frame; // first failed line = deepest failing frame
      } else {
        anomalies.push("failed line with no open frame");
      }
      continue;
    }

    if ((m = RE.failedToComplete.exec(line))) {
      // No id on this line, so we cannot pop by id. Do not pop: the runtime usually follows with
      // `Program <id> failed:` for the same frame. Remember the deepest open frame as fallback.
      failedToComplete = { message: m[1]! };
      failedToCompleteFrame = stack[stack.length - 1];
      continue;
    }

    if ((m = RE.programLog.exec(line))) {
      const payload = m[1]!;
      stack[stack.length - 1]?.logs.push(payload);
      const anchor = parseAnchorError(payload);
      if (anchor) anchorErrors.push(anchor);
      continue;
    }

    if (RE.programData.exec(line) || RE.programReturn.exec(line)) continue;

    if (line.startsWith("Program ")) anomalies.push(`unrecognised log line shape: ${line.slice(0, 80)}`);
  }

  // If no `failed:` line ever closed the failing frame (seen with bare failed-to-complete + truncation),
  // fall back to the deepest frame that was open when the bare line appeared.
  let failingViaFallback = false;
  if (!failing && failedToComplete && failedToCompleteFrame) {
    failedToCompleteFrame.outcome = "failed";
    failedToCompleteFrame.failMessage = failedToComplete.message;
    failing = failedToCompleteFrame;
    failingViaFallback = true;
  }

  // Only the error TEXT proves exhaustion. `consumed >= budget` on a failed frame does not:
  // a program can burn its whole budget and then fail for an unrelated reason (e.g. slippage),
  // and calling that "ran out of compute" would be a confidently wrong diagnosis.
  const computeExhausted = /exceeded CUs meter|exceeded maximum number of instructions|computational budget/i.test(
    `${failedToComplete?.message ?? ""} ${failing?.failMessage ?? ""}`,
  );

  return {
    frames,
    ...(failing ? { failing } : {}),
    ...(failedToComplete ? { failedToComplete } : {}),
    failingViaFallback,
    anchorErrors,
    truncated,
    computeExhausted,
    anomalies,
  };
}
