/**
 * Unit tests for substantiateSemanticEvidence (#826).
 *
 * Pinpoints the false-negative behaviour exposed by the
 * memory-phase4-graph-code-intelligence US-001 run: a real AC violation was
 * flagged but silently downgraded because the model phrased `verifiedBy.observed`
 * as a description rather than a verbatim code excerpt.
 *
 * Tests cover:
 * - Verbatim observed found on disk → preserved at severity "error"
 * - Whitespace + quote normalization still works for verbatim excerpts
 * - Prose-only observed (no substring match) → downgraded to "unverifiable"
 * - Downgrade emits a structured event with a stable marker + issue snippet
 *   so telemetry can correlate the suppression to the original finding
 * - Non-error findings pass through unchanged
 * - Embedded mode is a no-op (only ref mode substantiates)
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { _evidenceDeps, substantiateSemanticEvidence } from "../../../src/review/semantic-evidence";
import type { LLMFinding } from "../../../src/review/semantic-helpers";
import { makeLogger, type MockLogger } from "../../helpers/mock-logger";
import { withTempDir } from "../../helpers/temp";

const STORY_ID = "US-001";

let logger: MockLogger;
let origGetLogger: typeof _evidenceDeps.getLogger;

beforeEach(() => {
  logger = makeLogger();
  origGetLogger = _evidenceDeps.getLogger;
  _evidenceDeps.getLogger = () => logger as unknown as ReturnType<typeof _evidenceDeps.getLogger>;
});

afterEach(() => {
  _evidenceDeps.getLogger = origGetLogger;
});

function makeFinding(overrides: Partial<LLMFinding> = {}): LLMFinding {
  return {
    severity: "error",
    file: "src/foo.ts",
    line: 5,
    issue: "AC not implemented",
    suggestion: "Implement it",
    verifiedBy: {
      command: "sed -n '1,80p' src/foo.ts",
      file: "src/foo.ts",
      line: 5,
      observed: "export function foo() {}",
    },
    ...overrides,
  };
}

describe("substantiateSemanticEvidence — ref mode", () => {
  test("preserves error finding when verbatim observed appears in the file", async () => {
    await withTempDir(async (workdir) => {
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src/foo.ts"), "export function foo() {}\n");

      const result = await substantiateSemanticEvidence([makeFinding()], "ref", workdir, STORY_ID);

      expect(result[0].severity).toBe("error");
      expect(logger.calls.find((c) => c.message.includes("Downgraded"))).toBeUndefined();
    });
  });

  test("preserves error finding when observed differs only by whitespace and wrapping quotes", async () => {
    await withTempDir(async (workdir) => {
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src/foo.ts"), "const sum  =  a   +   b;\n");

      const finding = makeFinding({
        verifiedBy: {
          command: "cat src/foo.ts",
          file: "src/foo.ts",
          line: 1,
          observed: '"const sum = a + b;"',
        },
      });
      const result = await substantiateSemanticEvidence([finding], "ref", workdir, STORY_ID);

      expect(result[0].severity).toBe("error");
    });
  });

  test("downgrades error finding when observed is prose, not a verbatim excerpt", async () => {
    await withTempDir(async (workdir) => {
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(
        join(workdir, "src/foo.ts"),
        "function hasContentChanged(a, b) { return a.label !== b.label; }\n",
      );

      const finding = makeFinding({
        line: 1,
        issue:
          "hasContentChanged() does NOT check outgoing links, contradicting the AC requirement and its own docstring",
        verifiedBy: {
          command: "Read src/foo.ts",
          file: "src/foo.ts",
          line: 1,
          observed:
            "hasContentChanged only compares label, type, source_file — storedLinkMap is captured but hasContentChanged never receives or checks it.",
        },
      });
      const result = await substantiateSemanticEvidence([finding], "ref", workdir, STORY_ID);

      expect(result[0].severity).toBe("unverifiable");
    });
  });

  test("downgrade emits a structured event with stable marker + finding issue snippet", async () => {
    await withTempDir(async (workdir) => {
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src/foo.ts"), "function bar() {}\n");

      const finding = makeFinding({
        line: 109,
        issue: "hasContentChanged() ignores outgoing links",
        verifiedBy: {
          command: "Read src/foo.ts",
          file: "src/foo.ts",
          line: 109,
          observed: "hasContentChanged only compares label, type, source_file — storedLinkMap captured on line 814",
        },
      });

      await substantiateSemanticEvidence([finding], "ref", workdir, STORY_ID);

      const downgradeCall = logger.calls.find((c) => c.message === "Downgraded unsubstantiated semantic error finding");
      expect(downgradeCall).toBeDefined();
      expect(downgradeCall?.level).toBe("warn");
      expect(downgradeCall?.stage).toBe("review");
      expect(downgradeCall?.data?.event).toBe("review.semantic.finding.downgraded");
      expect(downgradeCall?.data?.storyId).toBe(STORY_ID);
      expect(downgradeCall?.data?.file).toBe("src/foo.ts");
      expect(downgradeCall?.data?.line).toBe(109);
      expect(downgradeCall?.data?.issue).toBe("hasContentChanged() ignores outgoing links");
      expect(typeof downgradeCall?.data?.observed).toBe("string");
    });
  });

  test("non-error severities pass through unchanged (no downgrade attempted)", async () => {
    await withTempDir(async (workdir) => {
      const findings: LLMFinding[] = [
        makeFinding({ severity: "warn" }),
        makeFinding({ severity: "info" }),
        makeFinding({ severity: "unverifiable" }),
      ];

      const result = await substantiateSemanticEvidence(findings, "ref", workdir, STORY_ID);

      expect(result.map((f) => f.severity)).toEqual(["warn", "info", "unverifiable"]);
      expect(logger.calls.find((c) => c.message.includes("Downgraded"))).toBeUndefined();
    });
  });

  test("preserves error finding when absolute verifiedBy.file does not exist on this machine", async () => {
    await withTempDir(async (workdir) => {
      // Simulates the real case: LLM ran its grep on a Mac against an absolute
      // path that doesn't exist in the current environment (CI, Linux, different
      // repo location). The file is unreadable, so we preserve rather than demote.
      const finding = makeFinding({
        verifiedBy: {
          command: "grep -n 'deleteAllBySourceType' /Users/williamkhoo/repos/koda/apps/api/src/rag/rag.service.ts",
          file: "/Users/williamkhoo/repos/koda/apps/api/src/rag/rag.service.ts",
          line: 723,
          observed: "const cleared = await this.deleteAllBySourceType(projectId, 'code');",
        },
      });

      const result = await substantiateSemanticEvidence([finding], "ref", workdir, STORY_ID);

      expect(result[0].severity).toBe("error");
      expect(logger.calls.find((c) => c.message.includes("Downgraded"))).toBeUndefined();
    });
  });

  test("downgrades error finding when absolute verifiedBy.file exists but snippet is absent", async () => {
    await withTempDir(async (workdir) => {
      // Write a real file at a known absolute path (temp dir) so the direct read
      // succeeds, then verify that a non-matching observed still downgrades.
      const absFile = join(workdir, "abs-target.ts");
      writeFileSync(absFile, "export function realCode() { return 42; }\n");

      const finding = makeFinding({
        verifiedBy: {
          command: `cat ${absFile}`,
          file: absFile,
          line: 1,
          observed: "this snippet does not appear in the file at all",
        },
      });

      const result = await substantiateSemanticEvidence([finding], "ref", workdir, STORY_ID);

      expect(result[0].severity).toBe("unverifiable");
      expect(logger.calls.find((c) => c.message.includes("Downgraded"))).toBeDefined();
    });
  });

  test("preserves error finding when absolute verifiedBy.file exists and snippet matches", async () => {
    await withTempDir(async (workdir) => {
      const absFile = join(workdir, "abs-target.ts");
      writeFileSync(absFile, "const cleared = await this.deleteAllBySourceType(projectId, 'code');\n");

      const finding = makeFinding({
        verifiedBy: {
          command: `grep -n deleteAllBySourceType ${absFile}`,
          file: absFile,
          line: 1,
          observed: "const cleared = await this.deleteAllBySourceType(projectId, 'code');",
        },
      });

      const result = await substantiateSemanticEvidence([finding], "ref", workdir, STORY_ID);

      expect(result[0].severity).toBe("error");
      expect(logger.calls.find((c) => c.message.includes("Downgraded"))).toBeUndefined();
    });
  });

  test("missing or empty verifiedBy.observed leaves error finding unchanged", async () => {
    await withTempDir(async (workdir) => {
      const findings: LLMFinding[] = [
        makeFinding({ verifiedBy: { command: "x", file: "src/foo.ts", line: 1, observed: "" } }),
        makeFinding({ verifiedBy: undefined }),
      ];

      const result = await substantiateSemanticEvidence(findings, "ref", workdir, STORY_ID);

      expect(result.every((f) => f.severity === "error")).toBe(true);
      expect(logger.calls.find((c) => c.message.includes("Downgraded"))).toBeUndefined();
    });
  });
});

describe("substantiateSemanticEvidence — embedded mode", () => {
  test("does not substantiate (passes findings through unchanged)", async () => {
    await withTempDir(async (workdir) => {
      const finding = makeFinding({
        verifiedBy: {
          command: "Read",
          file: "src/foo.ts",
          line: 1,
          observed: "this prose would normally be downgraded",
        },
      });
      const result = await substantiateSemanticEvidence([finding], "embedded", workdir, STORY_ID);

      expect(result[0].severity).toBe("error");
      expect(logger.calls).toHaveLength(0);
    });
  });
});
