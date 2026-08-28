import { describe, expect, it } from "vitest";
import { parseAnchorError, walkLogs } from "../src/logs";

const JUP = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const WHIRL = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

describe("walkLogs", () => {
  it("attributes consumed to the still-open frame (consumed precedes success)", () => {
    const walk = walkLogs([
      `Program ${JUP} invoke [1]`,
      "Program log: Instruction: Route",
      `Program ${WHIRL} invoke [2]`,
      `Program ${TOKEN} invoke [3]`,
      `Program ${TOKEN} consumed 4000 of 100000 compute units`,
      `Program ${TOKEN} success`,
      `Program ${WHIRL} consumed 30000 of 120000 compute units`,
      `Program ${WHIRL} success`,
      `Program ${JUP} consumed 60000 of 200000 compute units`,
      `Program ${JUP} success`,
    ]);
    expect(walk.frames).toHaveLength(3);
    expect(walk.frames.map((f) => f.height)).toEqual([1, 2, 3]);
    expect(walk.frames.map((f) => f.invocationOrdinal)).toEqual([0, 1, 2]);
    expect(walk.frames.map((f) => f.consumed)).toEqual([60000, 30000, 4000]);
    expect(walk.frames.every((f) => f.outcome === "success")).toBe(true);
    expect(walk.failing).toBeUndefined();
    expect(walk.anomalies).toEqual([]);
  });

  it("identifies the deepest failing frame as the FIRST failed line (ancestors fail too)", () => {
    const walk = walkLogs([
      `Program ${JUP} invoke [1]`,
      `Program ${WHIRL} invoke [2]`,
      "Program log: AnchorError occurred. Error Code: SlippageToleranceExceeded. Error Number: 6001. Error Message: Slippage tolerance exceeded.",
      `Program ${WHIRL} consumed 5000 of 100000 compute units`,
      `Program ${WHIRL} failed: custom program error: 0x1771`,
      `Program ${JUP} consumed 20000 of 200000 compute units`,
      `Program ${JUP} failed: custom program error: 0x1771`,
    ]);
    expect(walk.failing?.programId).toBe(WHIRL);
    expect(walk.failing?.height).toBe(2);
    expect(walk.failing?.invocationOrdinal).toBe(1);
    expect(walk.frames.filter((f) => f.outcome === "failed")).toHaveLength(2);
    expect(walk.anchorErrors).toHaveLength(1);
    expect(walk.anchorErrors[0]!.number).toBe(6001);
    // the AnchorError payload was emitted while the failing frame was deepest — association holds
    expect(walk.failing?.logs.some((l) => l.startsWith("AnchorError"))).toBe(true);
  });

  it("handles the id-less 'Program failed to complete:' line without popping by id", () => {
    const walk = walkLogs([
      `Program ${JUP} invoke [1]`,
      `Program ${WHIRL} invoke [2]`,
      "Program failed to complete: exceeded CUs meter at BPF instruction",
      `Program ${WHIRL} failed: Program failed to complete: exceeded CUs meter at BPF instruction`,
      `Program ${JUP} failed: Program failed to complete: exceeded CUs meter at BPF instruction`,
    ]);
    expect(walk.failing?.programId).toBe(WHIRL);
    expect(walk.computeExhausted).toBe(true);
    expect(walk.anomalies).toEqual([]);
  });

  it("falls back to the deepest open frame when no failed line follows the bare line", () => {
    const walk = walkLogs([`Program ${JUP} invoke [1]`, "Program failed to complete: oops"]);
    expect(walk.failing?.programId).toBe(JUP);
    expect(walk.failing?.outcome).toBe("failed");
    expect(walk.failingViaFallback).toBe(true); // inferred, not closed by a `failed:` line
  });

  it("does not call a failure compute exhaustion just because consumed == budget", () => {
    // A program can burn its whole budget and then fail for an unrelated reason (slippage).
    const walk = walkLogs([
      `Program ${JUP} invoke [1]`,
      `Program ${JUP} consumed 200000 of 200000 compute units`,
      `Program ${JUP} failed: custom program error: 0x1771`,
    ]);
    expect(walk.computeExhausted).toBe(false);
    expect(walk.failing?.programId).toBe(JUP);
  });

  it("degrades honestly on truncation instead of inventing outcomes", () => {
    const walk = walkLogs([`Program ${JUP} invoke [1]`, `Program ${WHIRL} invoke [2]`, "Log truncated"]);
    expect(walk.truncated).toBe(true);
    expect(walk.failing).toBeUndefined();
    expect(walk.frames.every((f) => f.outcome === "unclosed")).toBe(true);
  });

  it("counts compiled top-level ordinals across instructions", () => {
    const walk = walkLogs([
      `Program ${TOKEN} invoke [1]`,
      `Program ${TOKEN} success`,
      `Program ${JUP} invoke [1]`,
      `Program ${JUP} failed: custom program error: 0x1`,
    ]);
    expect(walk.frames.map((f) => f.topIndex)).toEqual([0, 1]);
    expect(walk.failing?.topIndex).toBe(1);
    expect(walk.failing?.invocationOrdinal).toBe(0);
  });
});

describe("parseAnchorError", () => {
  it("parses the 'thrown in file:line' variant", () => {
    const a = parseAnchorError(
      "AnchorError thrown in programs/amm/src/lib.rs:42. Error Code: SlippageExceeded. Error Number: 6001. Error Message: Slippage tolerance exceeded.",
    );
    expect(a).toMatchObject({ code: "SlippageExceeded", number: 6001, file: "programs/amm/src/lib.rs", line: 42 });
  });

  it("parses the 'caused by account' variant", () => {
    const a = parseAnchorError(
      "AnchorError caused by account: token_account. Error Code: ConstraintTokenOwner. Error Number: 2015. Error Message: A token owner constraint was violated.",
    );
    expect(a).toMatchObject({ code: "ConstraintTokenOwner", number: 2015, accountName: "token_account" });
  });

  it("parses the bare 'occurred' variant", () => {
    const a = parseAnchorError(
      "AnchorError occurred. Error Code: AccountNotInitialized. Error Number: 3012. Error Message: The program expected this account to be already initialized.",
    );
    expect(a).toMatchObject({ code: "AccountNotInitialized", number: 3012 });
  });

  it("returns undefined for ordinary log lines", () => {
    expect(parseAnchorError("Instruction: Route")).toBeUndefined();
    expect(parseAnchorError("Error: insufficient funds")).toBeUndefined();
  });
});
