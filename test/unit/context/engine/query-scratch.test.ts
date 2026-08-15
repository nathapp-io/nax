/**
 * query-scratch.ts — unit tests (US-005, split from pull-tools.test.ts)
 *
 * Covers QUERY_SCRATCH_DESCRIPTOR and handleQueryScratch. Lives in its own
 * file so the parent pull-tools.test.ts stays under the 800-line test file
 * hard limit (per project-conventions.md).
 *
 * Filesystem calls are intercepted via `_pullToolsDeps.fileExists` /
 * `_pullToolsDeps.readFile` injection. Cross-call test scratch JSONL files
 * are written via the real `appendScratchEntry` so the read path is exercised.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_MAX_CALLS_PER_SESSION } from "@/context/engine";
import {
  PULL_TOOL_REGISTRY,
  PullToolBudget,
  QUERY_SCRATCH_DESCRIPTOR,
  _pullToolsDeps,
  createRunCallCounter,
  handleQueryScratch,
} from "@/context/engine";
import { NaxError } from "@/errors";
import { appendScratchEntry, scratchFilePath } from "@/session";
import type { ScratchEntry } from "@/session";
import { cleanupTempDir, makeLogger, makeStory, makeTempDir } from "@test/helpers";

let origGetLogger: typeof _pullToolsDeps.getLogger;

beforeEach(() => {
  origGetLogger = _pullToolsDeps.getLogger;
  _pullToolsDeps.getLogger = () => makeLogger() as any;
});

afterEach(() => {
  _pullToolsDeps.getLogger = origGetLogger;
});

// ─────────────────────────────────────────────────────────────────────────────
// US-005: QUERY_SCRATCH_DESCRIPTOR
// ─────────────────────────────────────────────────────────────────────────────

describe("QUERY_SCRATCH_DESCRIPTOR", () => {
  test("AC1: PULL_TOOL_REGISTRY contains query_scratch whose descriptor name is query_scratch", () => {
    expect(QUERY_SCRATCH_DESCRIPTOR.name).toBe("query_scratch");
    expect(PULL_TOOL_REGISTRY.query_scratch).toBe(QUERY_SCRATCH_DESCRIPTOR);
  });

  test("AC2: inputSchema type is object and has no top-level oneOf or anyOf", () => {
    const schema = QUERY_SCRATCH_DESCRIPTOR.inputSchema as Record<string, unknown> & {
      type?: string;
      oneOf?: unknown;
      anyOf?: unknown;
    };
    expect(schema.type).toBe("object");
    expect(schema.oneOf).toBeUndefined();
    expect(schema.anyOf).toBeUndefined();
  });

  test("AC3: inputSchema declares optional kind and limit properties; required is empty or absent", () => {
    const schema = QUERY_SCRATCH_DESCRIPTOR.inputSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(schema.properties).toBeDefined();
    expect(schema.properties?.kind).toBeDefined();
    expect(schema.properties?.limit).toBeDefined();
    // Per AC3: required is empty or absent
    if (schema.required !== undefined) {
      expect(schema.required).toEqual([]);
    }
  });

  test("AC4: maxCallsPerSession equals DEFAULT_MAX_CALLS_PER_SESSION", () => {
    expect(QUERY_SCRATCH_DESCRIPTOR.maxCallsPerSession).toBe(DEFAULT_MAX_CALLS_PER_SESSION);
  });

  test("maxTokensPerCall is a positive integer", () => {
    expect(QUERY_SCRATCH_DESCRIPTOR.maxTokensPerCall).toBeGreaterThan(0);
    expect(Number.isInteger(QUERY_SCRATCH_DESCRIPTOR.maxTokensPerCall)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-005: handleQueryScratch
// ─────────────────────────────────────────────────────────────────────────────

describe("handleQueryScratch", () => {
  const STORY_ID = "US-005";
  const STORY = makeStory({ id: STORY_ID });

  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir("nax-query-scratch-");
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  function makeBudget(sessionLimit = 5, runLimit = 50, counter = createRunCallCounter()) {
    return { budget: new PullToolBudget(sessionLimit, runLimit, counter), counter };
  }

  async function writeScratchFile(scratchDir: string, entries: ScratchEntry[]): Promise<string> {
    await mkdir(scratchDir, { recursive: true });
    const filePath = scratchFilePath(scratchDir);
    for (const entry of entries) {
      await appendScratchEntry(scratchDir, entry);
    }
    return filePath;
  }

  test("AC5: returns a non-empty string naming the verify-result entry outcome", async () => {
    const scratchDir = join(tmpDir, "sess-ac5");
    await writeScratchFile(scratchDir, [
      {
        kind: "verify-result",
        timestamp: "2026-01-01T00:00:00.000Z",
        storyId: STORY_ID,
        stage: "verify",
        success: false,
        status: "TEST_FAILURE",
        passCount: 1,
        failCount: 1,
        rawOutputTail: "FAIL: expected 1 to equal 2",
      },
    ]);

    const { budget } = makeBudget();
    const result = await handleQueryScratch({}, STORY, [scratchDir], budget);

    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain("FAIL");
  });

  test("AC6: filter by kind=tool-diagnostics only includes diagnostics entries", async () => {
    const scratchDir = join(tmpDir, "sess-ac6");
    await writeScratchFile(scratchDir, [
      {
        kind: "tool-diagnostics",
        timestamp: "2026-01-01T00:00:00.000Z",
        storyId: STORY_ID,
        diagnostics: [
          { file: "src/a.ts", line: 1, severity: "error", message: "Cannot find name 'foo'.", tool: "tsc" },
        ],
      },
      {
        kind: "verify-result",
        timestamp: "2026-01-01T00:00:01.000Z",
        storyId: STORY_ID,
        stage: "verify",
        success: false,
        status: "TEST_FAILURE",
        passCount: 0,
        failCount: 1,
        rawOutputTail: "test failed",
      },
    ]);

    const { budget } = makeBudget();
    const result = await handleQueryScratch({ kind: "tool-diagnostics" }, STORY, [scratchDir], budget);

    expect(result).toContain("Cannot find name 'foo'");
    expect(result).not.toContain("test failed");
  });

  test("AC7: limit=1 returns exactly one entry against three entries", async () => {
    const scratchDir = join(tmpDir, "sess-ac7");
    await writeScratchFile(scratchDir, [
      {
        kind: "verify-result",
        timestamp: "2026-01-01T00:00:00.000Z",
        storyId: STORY_ID,
        stage: "verify",
        success: false,
        status: "TEST_FAILURE",
        passCount: 0,
        failCount: 1,
        rawOutputTail: "first tail",
      },
      {
        kind: "verify-result",
        timestamp: "2026-01-01T00:00:01.000Z",
        storyId: STORY_ID,
        stage: "verify",
        success: false,
        status: "TEST_FAILURE",
        passCount: 0,
        failCount: 1,
        rawOutputTail: "second tail",
      },
      {
        kind: "verify-result",
        timestamp: "2026-01-01T00:00:02.000Z",
        storyId: STORY_ID,
        stage: "verify",
        success: false,
        status: "TEST_FAILURE",
        passCount: 0,
        failCount: 1,
        rawOutputTail: "third tail",
      },
    ]);

    const { budget } = makeBudget();
    const result = await handleQueryScratch({ limit: 1 }, STORY, [scratchDir], budget);

    // AC7: limit=1 caps the response count. verify-result renders one block
    // per entry, so count the **Verify** headers to assert exactly one entry.
    const verifyHeaders = (result.match(/^\*\*Verify\*\*/gm) ?? []).length;
    expect(verifyHeaders).toBe(1);
  });

  test("AC8: missing scratch dir returns a no-entries message without throwing", async () => {
    const missingDir = join(tmpDir, "non-existent-sess");
    const { budget } = makeBudget();

    let result = "";
    let threw: unknown;
    try {
      result = await handleQueryScratch({}, STORY, [missingDir], budget);
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeUndefined();
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
    // No-entries message — should be a readable non-empty string
    expect(result.toLowerCase()).toContain("no");
  });

  test("AC9: kind filter with no matches returns a no-entries message", async () => {
    const scratchDir = join(tmpDir, "sess-ac9");
    await writeScratchFile(scratchDir, [
      {
        kind: "verify-result",
        timestamp: "2026-01-01T00:00:00.000Z",
        storyId: STORY_ID,
        stage: "verify",
        success: true,
        status: "PASS",
        passCount: 1,
        failCount: 0,
        rawOutputTail: "ok",
      },
    ]);

    const { budget } = makeBudget();
    const result = await handleQueryScratch({ kind: "tool-diagnostics" }, STORY, [scratchDir], budget);

    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
    expect(result.toLowerCase()).toContain("no");
  });

  test("AC10: cross-agent scratch content is neutralized for the requesting agent", async () => {
    const scratchDir = join(tmpDir, "sess-ac10");
    await writeScratchFile(scratchDir, [
      {
        kind: "verify-result",
        timestamp: "2026-01-01T00:00:00.000Z",
        storyId: STORY_ID,
        stage: "verify",
        success: false,
        status: "TEST_FAILURE",
        passCount: 0,
        failCount: 1,
        rawOutputTail: "I used the Read tool to check the file and the Bash tool to run tests.",
        writtenByAgent: "claude",
      },
    ]);

    const crossStory = makeStory({ id: STORY_ID });
    const { budget } = makeBudget();

    // Cross-agent read: the entry's writer is `writtenByAgent: "claude"` and
    // the requester is `targetAgent: "codex"`. The neutralizer runs because
    // the writer differs from the requester AND the writer is "claude" (the
    // known tool-name catalogue).
    const result = await handleQueryScratch({}, crossStory, [scratchDir], budget, {
      targetAgent: "codex",
    });

    // Claude-specific tool references must be neutralized
    expect(result).not.toContain("the Read tool");
    expect(result).not.toContain("the Bash tool");
    expect(result).toContain("a file read");
    expect(result).toContain("a shell command");
  });

  test("calls budget.consume() before fetching; propagates NaxError from exhausted budget", async () => {
    const scratchDir = join(tmpDir, "sess-budget");
    await writeScratchFile(scratchDir, [
      {
        kind: "verify-result",
        timestamp: "2026-01-01T00:00:00.000Z",
        storyId: STORY_ID,
        stage: "verify",
        success: true,
        status: "PASS",
        passCount: 1,
        failCount: 0,
        rawOutputTail: "ok",
      },
    ]);

    const { budget } = makeBudget();
    await handleQueryScratch({}, STORY, [scratchDir], budget);
    expect(budget.sessionCallsUsed).toBe(1);

    const exhausted = makeBudget(0, 50).budget;
    let threw: unknown;
    try {
      await handleQueryScratch({}, STORY, [scratchDir], exhausted);
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(NaxError);
    expect((threw as NaxError).code).toBe("PULL_TOOL_BUDGET_EXHAUSTED");
  });

  test("reads scratch from multiple scratch dirs (union)", async () => {
    const dirA = join(tmpDir, "sess-a");
    const dirB = join(tmpDir, "sess-b");
    await writeScratchFile(dirA, [
      {
        kind: "verify-result",
        timestamp: "2026-01-01T00:00:00.000Z",
        storyId: STORY_ID,
        stage: "verify",
        success: false,
        status: "TEST_FAILURE",
        passCount: 0,
        failCount: 1,
        rawOutputTail: "from-A",
      },
    ]);
    await writeScratchFile(dirB, [
      {
        kind: "verify-result",
        timestamp: "2026-01-01T00:00:01.000Z",
        storyId: STORY_ID,
        stage: "verify",
        success: false,
        status: "TEST_FAILURE",
        passCount: 0,
        failCount: 1,
        rawOutputTail: "from-B",
      },
    ]);

    const { budget } = makeBudget();
    const result = await handleQueryScratch({}, STORY, [dirA, dirB], budget);

    expect(result).toContain("from-A");
    expect(result).toContain("from-B");
  });

  test("records invocation on the run counter", async () => {
    const scratchDir = join(tmpDir, "sess-record");
    await writeScratchFile(scratchDir, [
      {
        kind: "verify-result",
        timestamp: "2026-01-01T00:00:00.000Z",
        storyId: STORY_ID,
        stage: "verify",
        success: true,
        status: "PASS",
        passCount: 1,
        failCount: 0,
        rawOutputTail: "ok",
      },
    ]);

    const { budget, counter } = makeBudget();
    await handleQueryScratch({ kind: "verify-result" }, STORY, [scratchDir], budget);

    expect(counter.calls).toHaveLength(1);
    expect(counter.calls[0]?.tool).toBe("query_scratch");
    expect(counter.calls[0]?.query).toBe("verify-result");
  });
});
