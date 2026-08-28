// Golden tests over the committed mainnet fixtures. No network — ever.
// If a fixture class regresses here, the decoder changed behaviour on real data.

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { decodeTransaction } from "../src/decode";
import { renderText } from "../src/render/text";
import type { GetTransactionResult } from "../src/types";

const FIXTURES_DIR = fileURLToPath(new URL("../../../fixtures/", import.meta.url));
const TOKEN_PROGRAMS = new Set([
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
]);

interface FixtureFile {
  signature: string;
  class: string;
  response: GetTransactionResult;
}

function loadClass(cls: string): FixtureFile {
  const dir = path.join(FIXTURES_DIR, cls);
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  expect(files, `${cls} should hold exactly one fixture`).toHaveLength(1);
  return JSON.parse(readFileSync(path.join(dir, files[0]!), "utf8")) as FixtureFile;
}

const CLASSES = ["compute-exhausted", "anchor-constraint", "anchor-custom", "spl-token", "deep-cpi"];

describe("committed fixtures", () => {
  it("manifest and files agree; five distinct real transactions", () => {
    const manifest = JSON.parse(readFileSync(path.join(FIXTURES_DIR, "index.json"), "utf8")) as {
      cls: string;
      signature: string;
    }[];
    expect(manifest.map((m) => m.cls).sort()).toEqual([...CLASSES].sort());
    const signatures = manifest.map((m) => m.signature);
    expect(new Set(signatures).size).toBe(5);
    for (const m of manifest) {
      expect(loadClass(m.cls).signature).toBe(m.signature);
    }
  });

  for (const cls of CLASSES) {
    describe(cls, () => {
      const fixture = loadClass(cls);
      const decoded = decodeTransaction(fixture.response);
      const { analysis, tree } = decoded;

      it("decodes as a failed transaction with a confirmed failing program", () => {
        expect(analysis.status).toBe("failed");
        expect(analysis.kind).toBe("instruction_error");
        expect(analysis.crossCheck).toBe("confirmed");
        expect(analysis.failingProgram).toBeDefined();
      });

      it("carries the class-defining evidence", () => {
        switch (cls) {
          case "compute-exhausted":
            expect(analysis.computeExhausted).toBe(true);
            break;
          case "anchor-constraint":
            expect(analysis.anchorError).toBeDefined();
            expect(analysis.anchorError!.number).toBeGreaterThanOrEqual(2000);
            expect(analysis.anchorError!.number).toBeLessThan(3000);
            break;
          case "anchor-custom":
            expect(analysis.anchorError).toBeDefined();
            expect(analysis.anchorError!.number).toBeGreaterThanOrEqual(6000);
            break;
          case "spl-token":
            expect(TOKEN_PROGRAMS.has(analysis.failingProgram!.id)).toBe(true);
            break;
          case "deep-cpi":
            expect(tree.maxDepth).toBeGreaterThanOrEqual(3);
            expect(analysis.failingProgram!.depth).toBeGreaterThanOrEqual(2);
            break;
        }
      });

      it("renders the golden text serialisation", () => {
        const text = renderText(fixture.response, decoded.tree, decoded.walk, analysis);
        expect(text).toContain("FAILED");
        expect(text).toContain(fixture.signature);
        expect(text).toMatchSnapshot();
      });
    });
  }
});
