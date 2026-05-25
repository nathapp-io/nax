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
import {
  _evidenceDeps,
  checkFindingEvidence,
  downgradeUnsubstantiatedFinding,
  substantiateSemanticEvidence,
} from "../../../src/review/semantic-evidence";
import type { AdversarialLLMFinding } from "@/review/adversarial-helpers";
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

      const downgradeCall = logger.calls.find((c) => c.message === "Downgraded unsubstantiated review finding");
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

  test("downgrades warning finding when blockingThreshold is warning", async () => {
    await withTempDir(async (workdir) => {
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src/foo.ts"), "export function foo() {}\n");

      const finding = makeFinding({
        severity: "warning",
        verifiedBy: {
          command: "Read src/foo.ts",
          file: "src/foo.ts",
          line: 1,
          observed: "this prose does not appear in the file",
        },
      });

      const result = await substantiateSemanticEvidence([finding], "ref", workdir, STORY_ID, "warning");
      expect(result[0].severity).toBe("unverifiable");
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

describe("checkFindingEvidence()", () => {
  test("returns unreadable when referenced file cannot be read", async () => {
    await withTempDir(async (workdir) => {
      const result = await checkFindingEvidence({
        finding: makeFinding({
          verifiedBy: {
            command: "cat /missing/file.ts",
            file: "/missing/file.ts",
            line: 1,
            observed: "missing snippet",
          },
        }),
        workdir,
      });

      expect(result.status).toBe("unreadable");
    });
  });
});

describe("checkFindingEvidence — line-anchored window", () => {
  // Defense-in-depth for the requote loop. The original full-file substring
  // check let "recovered" findings reinstate themselves with a quote from
  // anywhere in the file — line numbers could drift freely. These tests pin
  // the behaviour: the observed must appear within ±10 lines of the cited line.
  function makeMultiLineFile(): string {
    return Array.from({ length: 60 }, (_, i) => `// line ${i + 1}`).join("\n") + "\n";
  }

  test("matches when observed appears at the cited line", async () => {
    await withTempDir(async (workdir) => {
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src/foo.ts"), makeMultiLineFile());

      const result = await checkFindingEvidence({
        finding: makeFinding({
          line: 30,
          verifiedBy: { command: "cat src/foo.ts", file: "src/foo.ts", line: 30, observed: "// line 30" },
        }),
        workdir,
      });

      expect(result.status).toBe("matched");
    });
  });

  test("matches when observed appears within the ±10 line window", async () => {
    await withTempDir(async (workdir) => {
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src/foo.ts"), makeMultiLineFile());

      // Cited line 30, observed lives at line 38 — inside the ±10 window.
      const result = await checkFindingEvidence({
        finding: makeFinding({
          line: 30,
          verifiedBy: { command: "cat src/foo.ts", file: "src/foo.ts", line: 30, observed: "// line 38" },
        }),
        workdir,
      });

      expect(result.status).toBe("matched");
    });
  });

  test("does NOT match when observed appears in the file but outside the cited window", async () => {
    await writeMultiAndCheck("// line 50", 1, "unmatched");
  });

  test("matches when line is undefined (falls back to full-file scan)", async () => {
    await withTempDir(async (workdir) => {
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src/foo.ts"), makeMultiLineFile());

      // Both finding.line and verifiedBy.line omitted (using `0` to mean
      // "no usable line" since the type requires a number).
      const finding = makeFinding({
        line: 0,
        verifiedBy: { command: "cat src/foo.ts", file: "src/foo.ts", line: 0, observed: "// line 50" },
      });
      const result = await checkFindingEvidence({ finding, workdir });

      expect(result.status).toBe("matched");
    });
  });

  test("clamps cited line past EOF to the file's last line", async () => {
    await withTempDir(async (workdir) => {
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src/foo.ts"), makeMultiLineFile());

      // File has 60 lines; cited line is 200. Window clamps to lines 50-60,
      // so a quote of "// line 55" (within that clamped window) still matches.
      const result = await checkFindingEvidence({
        finding: makeFinding({
          line: 200,
          verifiedBy: { command: "cat src/foo.ts", file: "src/foo.ts", line: 200, observed: "// line 55" },
        }),
        workdir,
      });

      expect(result.status).toBe("matched");
    });
  });

  async function writeMultiAndCheck(
    observed: string,
    line: number,
    expected: "matched" | "unmatched" | "unreadable" | "missing-observed",
  ): Promise<void> {
    await withTempDir(async (workdir) => {
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src/foo.ts"), makeMultiLineFile());

      const result = await checkFindingEvidence({
        finding: makeFinding({
          line,
          verifiedBy: { command: "cat src/foo.ts", file: "src/foo.ts", line, observed },
        }),
        workdir,
      });

      expect(result.status).toBe(expected);
    });
  }
});

describe("checkFindingEvidence — generalized over Finding shape (Issue #987)", () => {
  test("accepts AdversarialLLMFinding shape and substantiates against disk", async () => {
    await withTempDir(async (workdir) => {
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src/foo.ts"), "export function login() {}\n");

      const adversarialFinding: AdversarialLLMFinding = {
        severity: "error",
        category: "abandonment",
        file: "src/foo.ts",
        line: 1,
        issue: "login is empty",
        suggestion: "Implement it",
        verifiedBy: {
          command: "cat src/foo.ts",
          file: "src/foo.ts",
          line: 1,
          observed: "export function login() {}",
        },
      };

      const result = await checkFindingEvidence({ finding: adversarialFinding, workdir });
      expect(result.status).toBe("matched");
    });
  });

  test("downgradeUnsubstantiatedFinding preserves AdversarialLLMFinding fields and sets severity=unverifiable", () => {
    const adversarialFinding: AdversarialLLMFinding = {
      severity: "error",
      category: "convention",
      file: "src/bar.ts",
      line: 5,
      issue: "phantom violation",
      suggestion: "Fix it",
      acQuote: "must X",
      acIndex: 1,
      verifiedBy: { command: "cat", file: "src/bar.ts", line: 5, observed: "not in file" },
    };

    const result = downgradeUnsubstantiatedFinding({
      finding: adversarialFinding,
      storyId: STORY_ID,
      event: "review.adversarial.finding.downgraded",
    });

    expect(result.severity).toBe("unverifiable");
    expect(result.category).toBe("convention");
    expect(result.acIndex).toBe(1);
  });
});
