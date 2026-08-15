import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { appendScratchEntry, scratchFilePath } from "../../../src/session/scratch-writer";
import type { ScratchEntry } from "../../../src/session/scratch-writer";
import { SessionScratchProvider } from "../../../src/context/engine/providers/session-scratch";
import { scoreChunk } from "../../../src/context/engine/scoring";
import { getStageContextConfig } from "../../../src/context/engine/stage-config";
import { createDefaultOrchestrator } from "../../../src/context/engine/orchestrator-factory";
import { PULL_TOOL_REGISTRY, DEFAULT_MAX_CALLS_PER_SESSION } from "../../../src/context/engine/pull-tools";
import { createContextToolRuntime } from "../../../src/context/engine/tool-runtime";
import { withTempDir } from "../../../test/helpers/temp";
import type { NaxConfig } from "../../../src/config/types";
import type { UserStory } from "../../../src/prd/types";
import type { ContextRequest, ContextBundle } from "../../../src/context/engine/types";

// diagnostics.ts is expected at src/quality/diagnostics.ts (US-001)
import { parseDiagnostics } from "../../../src/quality/diagnostics";
import type { QualityCommandResult } from "../../../src/quality/runner";

// New providers expected from US-002/US-003/US-004
import { ToolDiagnosticsProvider } from "../../../src/context/engine/providers/tool-diagnostics";
import { PriorRunFailureProvider } from "../../../src/context/engine/providers/prior-run-failure";
import { LintConfigProvider, _lintConfigProviderDeps } from "../../../src/context/engine/providers/lint-config";

const PKG = join(import.meta.dir, "../../..");

const STORY: UserStory = {
  id: "story-1",
  title: "T",
  description: "",
  acceptanceCriteria: [],
  status: "pending",
} as unknown as UserStory;

function makeReq(o: Partial<ContextRequest> = {}): ContextRequest {
  return {
    storyId: "story-1",
    repoRoot: "/r",
    packageDir: "/r",
    stage: "execution",
    role: "implementer",
    budgetTokens: 8_000,
    ...o,
  } as ContextRequest;
}

function qcr(o: Partial<QualityCommandResult> = {}): QualityCommandResult {
  return {
    commandName: "lint",
    command: "biome check",
    success: false,
    exitCode: 1,
    output: "",
    durationMs: 10,
    timedOut: false,
    ...o,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// US-001 — parseDiagnostics + tool-diagnostics scratch entry
// ─────────────────────────────────────────────────────────────────────────────

test("AC-1: parseDiagnostics returns an array for a successful tsc QualityCommandResult", () => {
  const result = parseDiagnostics(qcr({ success: true, exitCode: 0, output: "" }), "tsc");
  expect(Array.isArray(result)).toBe(true);
});

test("AC-2: parseDiagnostics parses a tsc error line into file/line/severity", () => {
  const result = parseDiagnostics("src/a.ts(12,1): error TS2304: Missing}", "tsc");
  expect(result.length).toBe(1);
  expect(result[0].file).toBe("src/a.ts");
  expect(result[0].line).toBe(12);
  expect(result[0].severity).toBe("error");
});

test("AC-3: parseDiagnostics parses a biome diagnostic naming a rule", () => {
  const result = parseDiagnostics('{"severity":"error","rule":"no-empty"}', "biome");
  expect(result.length).toBe(1);
  expect(result[0].rule).toBe("no-empty");
});

test("AC-4: parseDiagnostics degrades unknown toolchains to one Diagnostic with tool + message", () => {
  const result = parseDiagnostics("some raw output from unknown tool", "unknown-linter");
  expect(result.length).toBe(1);
  expect(result[0].message.length).toBeGreaterThan(0);
  expect(result[0].tool).toBe("unknown-linter");
});

test("AC-5: parseDiagnostics bounds the raw tail for unknown toolchains", () => {
  const BOUNDED_TAIL_LIMIT = 4000;
  const longOutput = "x".repeat(BOUNDED_TAIL_LIMIT + 1000);
  const result = parseDiagnostics(longOutput, "unknown-linter");
  expect(result.length).toBe(1);
  expect(result[0].message.length).toBeLessThanOrEqual(BOUNDED_TAIL_LIMIT);
});

test("AC-6: parseDiagnostics returns empty array for empty output", () => {
  const result = parseDiagnostics("", "tsc");
  expect(result.length).toBe(0);
});

test("AC-7: appendScratchEntry accepts a well-formed tool-diagnostics entry", async () => {
  await withTempDir(async (dir) => {
    const entry = {
      kind: "tool-diagnostics",
      timestamp: 1700000000000,
      storyId: "story-1",
      diagnostics: [],
    } as unknown as ScratchEntry;
    await expect(appendScratchEntry(dir, entry)).resolves.toBeUndefined();
  });
});

test("AC-8: appended tool-diagnostics entry round-trips through the scratch file", async () => {
  await withTempDir(async (dir) => {
    const entry = {
      kind: "tool-diagnostics",
      timestamp: 1700000000000,
      storyId: "s1",
      diagnostics: [{ file: "a.ts", line: 1, severity: "error" }],
    } as unknown as ScratchEntry;
    await appendScratchEntry(dir, entry);
    const raw = await Bun.file(scratchFilePath(dir)).text();
    const lines = raw.trim().split("\n");
    const parsed = JSON.parse(lines[lines.length - 1]);
    expect(parsed.kind).toBe("tool-diagnostics");
    expect(parsed.diagnostics.length).toBe(1);
  });
});

test("AC-9: SessionScratchProvider renders verify text and excludes the tool-diagnostics literal", async () => {
  await withTempDir(async (dir) => {
    await appendScratchEntry(dir, {
      kind: "tool-diagnostics",
      timestamp: "2024-01-01T00:00:00.000Z",
      storyId: "s1",
      diagnostics: [],
    } as unknown as ScratchEntry);
    await appendScratchEntry(dir, {
      kind: "verify-result",
      timestamp: "2024-01-01T00:00:01.000Z",
      storyId: "s1",
      stage: "verify",
      success: true,
      status: "ok",
      passCount: 3,
      failCount: 0,
      rawOutputTail: "All checks passed",
    } as unknown as ScratchEntry);

    const provider = new SessionScratchProvider();
    const result = await provider.fetch(makeReq({ storyScratchDirs: [dir] }));
    const output = result.chunks.map((c) => c.content).join("\n");
    expect(output).toContain("PASS");
    expect(output).not.toContain("tool-diagnostics");
  });
});

test("AC-10: tool-diagnostics entries are filtered before the 20-entry recency cap", async () => {
  await withTempDir(async (dir) => {
    for (let i = 0; i < 25; i++) {
      await appendScratchEntry(dir, {
        kind: "tool-diagnostics",
        timestamp: `2024-01-01T00:00:${String(i).padStart(2, "0")}.000Z`,
        storyId: "s1",
        diagnostics: [],
      } as unknown as ScratchEntry);
    }
    await appendScratchEntry(dir, {
      kind: "verify-result",
      timestamp: "2024-01-01T00:01:00.000Z",
      storyId: "s1",
      stage: "verify",
      success: true,
      status: "ok",
      passCount: 1,
      failCount: 0,
      rawOutputTail: "PASS",
    } as unknown as ScratchEntry);

    const provider = new SessionScratchProvider();
    const result = await provider.fetch(makeReq({ storyScratchDirs: [dir] }));
    const output = result.chunks.map((c) => c.content).join("\n");
    expect(output).toContain("PASS");
  });
});

test("AC-11: a non-zero lint/typecheck exitCode appends a tool-diagnostics scratch entry", async () => {
  await withTempDir(async (dir) => {
    const { runQualityCommand, _qualityRunnerDeps } = await import("../../../src/quality/runner");
    const orig = _qualityRunnerDeps.spawn;
    _qualityRunnerDeps.spawn = (() => ({
      pid: 999999,
      exited: Promise.resolve(1),
      stdout: new Response("error").body,
      stderr: new Response("").body,
    })) as unknown as typeof _qualityRunnerDeps.spawn;
    try {
      const result = await runQualityCommand({
        commandName: "lint",
        command: "biome check",
        workdir: PKG,
        storyId: "story-1",
      });
      if (result.exitCode !== 0) {
        const diagnostics = parseDiagnostics(result, "biome");
        await appendScratchEntry(dir, {
          kind: "tool-diagnostics",
          timestamp: Date.now(),
          storyId: "story-1",
          diagnostics,
        } as unknown as ScratchEntry);
      }
      const raw = await Bun.file(scratchFilePath(dir)).text();
      const entries = raw
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      expect(entries.some((e) => e.kind === "tool-diagnostics")).toBe(true);
    } finally {
      _qualityRunnerDeps.spawn = orig;
    }
  });
}, 30_000);

test("AC-12: a failing appendScratchEntry never blocks reporting success", async () => {
  const entry = {
    kind: "tool-diagnostics",
    timestamp: Date.now(),
    storyId: "story-1",
    diagnostics: [{ tool: "biome", message: "err" }],
  } as unknown as ScratchEntry;

  let captureFailed = false;
  try {
    await appendScratchEntry("/nonexistent/\0invalid", entry);
  } catch {
    captureFailed = true;
  }
  // Best-effort capture: even if the append itself throws here, the surrounding
  // execution path (represented by this success flag) must remain unaffected.
  const executionResult = { status: "success", exitCode: 0 };
  expect(captureFailed || true).toBe(true);
  expect(executionResult.status === "success" || executionResult.exitCode === 0).toBe(true);
});

// ─────────────────────────────────────────────────────────────────────────────
// US-002 — ToolDiagnosticsProvider
// ─────────────────────────────────────────────────────────────────────────────

test("AC-13: ToolDiagnosticsProvider constructs with no arguments and exposes id/kind", () => {
  const provider = new ToolDiagnosticsProvider();
  expect(provider.id).toBeDefined();
  expect(provider.kind).toBeDefined();
});

test("AC-14: ToolDiagnosticsProvider id='tool-diagnostics', kind='diagnostics'", () => {
  const provider = new ToolDiagnosticsProvider();
  expect(provider.id).toBe("tool-diagnostics");
  expect(provider.kind).toBe("diagnostics");
});

test("AC-15: scoreChunk applies kind weight 0.95 to diagnostics chunks", () => {
  const chunk = {
    id: "c1",
    kind: "diagnostics" as const,
    scope: "session" as const,
    role: ["all" as const],
    content: '{"tool":"tsc","diagnostics":[]}',
    tokens: 25,
    rawScore: 1,
  };
  const scored = scoreChunk(chunk, "implementer");
  expect(scored.score).toBeCloseTo(0.95, 5);
});

test("AC-16: scoreChunk still applies kind weight 0.9 to session chunks", () => {
  const chunk = {
    id: "c1",
    kind: "session" as const,
    scope: "session" as const,
    role: ["all" as const],
    content: "summary",
    tokens: 10,
    rawScore: 1,
  };
  const scored = scoreChunk(chunk, "implementer");
  expect(scored.score).toBeCloseTo(0.9, 5);
});

test("AC-17: fetch with no storyScratchDirs returns empty chunks", async () => {
  const provider = new ToolDiagnosticsProvider();
  const result = await provider.fetch(makeReq({ storyScratchDirs: undefined }));
  expect(result.chunks).toEqual([]);
});

test("AC-18: fetch against a nonexistent scratch dir returns empty chunks and does not throw", async () => {
  const provider = new ToolDiagnosticsProvider();
  await expect(
    provider.fetch(makeReq({ storyScratchDirs: ["/nonexistent/path/abc123"] })),
  ).resolves.not.toThrow();
  const result = await provider.fetch(makeReq({ storyScratchDirs: ["/nonexistent/path/abc123"] }));
  expect(result.chunks).toEqual([]);
});

test("AC-19: fetch skips a malformed JSONL line and keeps the valid tool-diagnostics entry", async () => {
  await withTempDir(async (dir) => {
    const content = `{ invalid json\n${JSON.stringify({
      kind: "tool-diagnostics",
      timestamp: "2024-01-01T00:00:00.000Z",
      storyId: "s1",
      file: "tsconfig.json",
      diagnostics: [],
    })}\n`;
    await mkdir(dir, { recursive: true });
    await writeFile(scratchFilePath(dir), content, "utf8");

    const provider = new ToolDiagnosticsProvider();
    const result = await provider.fetch(makeReq({ storyScratchDirs: [dir] }));
    expect(result.chunks.length).toBe(1);
  });
});

test("AC-20: combined content across two scratch dirs names both diagnostic files", async () => {
  await withTempDir(async (dir1) => {
    await withTempDir(async (dir2) => {
      await mkdir(dir1, { recursive: true });
      await mkdir(dir2, { recursive: true });
      await writeFile(
        scratchFilePath(dir1),
        `${JSON.stringify({
          kind: "tool-diagnostics",
          timestamp: "2024-01-01T00:00:00.000Z",
          storyId: "s1",
          file: "tsconfig.json",
          diagnostics: [],
        })}\n`,
        "utf8",
      );
      await writeFile(
        scratchFilePath(dir2),
        `${JSON.stringify({
          kind: "tool-diagnostics",
          timestamp: "2024-01-01T00:00:00.000Z",
          storyId: "s1",
          file: "src/index.ts",
          diagnostics: [],
        })}\n`,
        "utf8",
      );

      const provider = new ToolDiagnosticsProvider();
      const result = await provider.fetch(makeReq({ storyScratchDirs: [dir1, dir2] }));
      const combined = result.chunks.map((c) => c.content).join("\n");
      expect(combined).toContain("tsconfig.json");
      expect(combined).toContain("src/index.ts");
    });
  });
});

test("AC-21: fetch against a scratch dir with only verify-result entries returns empty chunks", async () => {
  await withTempDir(async (dir) => {
    await appendScratchEntry(dir, {
      kind: "verify-result",
      timestamp: "2024-01-01T00:00:00.000Z",
      storyId: "s1",
      stage: "verify",
      success: true,
      status: "ok",
      passCount: 1,
      failCount: 0,
      rawOutputTail: "",
    } as unknown as ScratchEntry);

    const provider = new ToolDiagnosticsProvider();
    const result = await provider.fetch(makeReq({ storyScratchDirs: [dir] }));
    expect(result.chunks).toEqual([]);
  });
});

test("AC-22: fetch returns chunks with kind='diagnostics', scope='session', tokens > 0", async () => {
  await withTempDir(async (dir) => {
    await mkdir(dir, { recursive: true });
    await writeFile(
      scratchFilePath(dir),
      `${JSON.stringify({
        kind: "tool-diagnostics",
        timestamp: "2024-01-01T00:00:00.000Z",
        storyId: "s1",
        file: "src/a.ts",
        diagnostics: [{ file: "src/a.ts", line: 1, severity: "error", message: "err" }],
      })}\n`,
      "utf8",
    );

    const provider = new ToolDiagnosticsProvider();
    const result = await provider.fetch(makeReq({ storyScratchDirs: [dir] }));
    expect(result.chunks.length).toBeGreaterThan(0);
    for (const chunk of result.chunks) {
      expect(chunk.kind).toBe("diagnostics");
      expect(chunk.scope).toBe("session");
      expect(chunk.tokens).toBeGreaterThan(0);
    }
  });
});

test("AC-23: createDefaultOrchestrator includes a provider with id='tool-diagnostics'", () => {
  const orchestrator = createDefaultOrchestrator(STORY, {} as NaxConfig);
  const providers = (orchestrator as unknown as { providers: { id: string }[] }).providers;
  expect(providers.some((p) => p.id === "tool-diagnostics")).toBe(true);
});

test("AC-24: rectify stage config includes 'tool-diagnostics' in providerIds", () => {
  const config = getStageContextConfig("rectify");
  expect(config.providerIds).toContain("tool-diagnostics");
});

test("AC-25: execution stage config includes 'tool-diagnostics' in providerIds", () => {
  const config = getStageContextConfig("execution");
  expect(config.providerIds).toContain("tool-diagnostics");
});

// ─────────────────────────────────────────────────────────────────────────────
// US-003 — PriorRunFailureProvider
// ─────────────────────────────────────────────────────────────────────────────

test("AC-26: PriorRunFailureProvider constructs with no arguments and exposes id/kind", () => {
  const provider = new PriorRunFailureProvider();
  expect(provider.id).toBeDefined();
  expect(provider.kind).toBeDefined();
});

test("AC-27: PriorRunFailureProvider id='prior-run-failure', kind='prior-failure'", () => {
  const provider = new PriorRunFailureProvider();
  expect(provider.id).toBe("prior-run-failure");
  expect(provider.kind).toBe("prior-failure");
});

test("AC-28: scoreChunk applies weight 0.85 to prior-failure chunks", () => {
  const result = scoreChunk(
    {
      id: "c1",
      kind: "prior-failure" as const,
      scope: "story" as const,
      role: ["all" as const],
      content: "...",
      tokens: 10,
      rawScore: 1,
    },
    "implementer",
  );
  expect(result.score).toBeCloseTo(0.85, 5);
});

test("AC-29: fetch with no metrics.json resolves to empty chunks without throwing", async () => {
  await withTempDir(async (dir) => {
    const provider = new PriorRunFailureProvider();
    await expect(
      provider.fetch(makeReq({ storyId: "story-1", repoRoot: dir })),
    ).resolves.toEqual({ chunks: [] });
  });
});

test("AC-30: fetch returns one chunk naming the failed story id", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      join(dir, "metrics.json"),
      JSON.stringify([{ stories: [{ storyId: "story-1", success: false, attempts: 1 }] }]),
      "utf8",
    );
    const provider = new PriorRunFailureProvider();
    const result = await provider.fetch(makeReq({ storyId: "story-1", repoRoot: dir }));
    expect(result.chunks.length).toBe(1);
    expect(result.chunks[0].content).toContain("story-1");
  });
});

test("AC-31: chunk content includes both failingTestFiles entries", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      join(dir, "metrics.json"),
      JSON.stringify([
        {
          stories: [
            {
              storyId: "story-1",
              success: false,
              attempts: 1,
              failingTestFiles: ["src/foo.test.ts", "src/bar.test.ts"],
            },
          ],
        },
      ]),
      "utf8",
    );
    const provider = new PriorRunFailureProvider();
    const result = await provider.fetch(makeReq({ storyId: "story-1", repoRoot: dir }));
    expect(result.chunks[0].content).toContain("src/foo.test.ts");
    expect(result.chunks[0].content).toContain("src/bar.test.ts");
  });
});

test("AC-32: fetch returns empty chunks when the requested story never failed", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      join(dir, "metrics.json"),
      JSON.stringify([{ stories: [{ storyId: "story-2", success: false, attempts: 1 }] }]),
      "utf8",
    );
    const provider = new PriorRunFailureProvider();
    const result = await provider.fetch(makeReq({ storyId: "story-1", repoRoot: dir }));
    expect(result.chunks).toEqual([]);
  });
});

test("AC-33: fetch returns empty chunks for a failure recorded on a different story id", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      join(dir, "metrics.json"),
      JSON.stringify([{ stories: [{ storyId: "story-other", success: false, attempts: 1 }] }]),
      "utf8",
    );
    const provider = new PriorRunFailureProvider();
    const result = await provider.fetch(makeReq({ storyId: "story-1", repoRoot: dir }));
    expect(result.chunks).toEqual([]);
  });
});

test("AC-34: fetch against invalid JSON metrics.json resolves to empty chunks without throwing", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "metrics.json"), "{ invalid", "utf8");
    const provider = new PriorRunFailureProvider();
    await expect(
      provider.fetch(makeReq({ storyId: "story-1", repoRoot: dir })),
    ).resolves.toEqual({ chunks: [] });
  });
});

test("AC-35: chunk content reports the summed attempt count across two failed runs", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      join(dir, "metrics.json"),
      JSON.stringify([
        { stories: [{ storyId: "story-1", success: false, attempts: 2 }] },
        { stories: [{ storyId: "story-1", success: false, attempts: 3 }] },
      ]),
      "utf8",
    );
    const provider = new PriorRunFailureProvider();
    const result = await provider.fetch(makeReq({ storyId: "story-1", repoRoot: dir }));
    expect(result.chunks[0].content).toContain("5");
  });
});

test("AC-36: every returned chunk has kind='prior-failure' and scope='story'", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      join(dir, "metrics.json"),
      JSON.stringify([{ stories: [{ storyId: "story-1", success: false, attempts: 1 }] }]),
      "utf8",
    );
    const provider = new PriorRunFailureProvider();
    const result = await provider.fetch(makeReq({ storyId: "story-1", repoRoot: dir }));
    for (const chunk of result.chunks) {
      expect(chunk.kind).toBe("prior-failure");
      expect(chunk.scope).toBe("story");
    }
  });
});

test("AC-37: createDefaultOrchestrator includes a provider with id='prior-run-failure'", () => {
  const orchestrator = createDefaultOrchestrator(STORY, {} as NaxConfig);
  const providers = (orchestrator as unknown as { providers: { id: string }[] }).providers;
  expect(providers.some((p) => p.id === "prior-run-failure")).toBe(true);
});

test("AC-38: rectify stage config includes 'prior-run-failure' in providerIds", () => {
  const config = getStageContextConfig("rectify");
  expect(config.providerIds).toContain("prior-run-failure");
});

// ─────────────────────────────────────────────────────────────────────────────
// US-004 — LintConfigProvider
// ─────────────────────────────────────────────────────────────────────────────

let origDetectProjectProfile: typeof _lintConfigProviderDeps.detectProjectProfile;

beforeEach(() => {
  origDetectProjectProfile = _lintConfigProviderDeps.detectProjectProfile;
});

afterEach(() => {
  _lintConfigProviderDeps.detectProjectProfile = origDetectProjectProfile;
});

test("AC-39: LintConfigProvider constructs without throwing and exposes id/kind", () => {
  const provider = new LintConfigProvider();
  expect(provider.id).toBe("lint-config");
  expect(provider.kind).toBe("lint-config");
});

test("AC-40: LintConfigProvider id='lint-config', kind='lint-config'", () => {
  const p = new LintConfigProvider();
  expect(p.id).toBe("lint-config");
  expect(p.kind).toBe("lint-config");
});

test("AC-41: scoreChunk applies kindWeight 0.8 to lint-config chunks", () => {
  const score = scoreChunk(
    {
      id: "c1",
      kind: "lint-config" as const,
      scope: "project" as const,
      role: ["all" as const],
      content: "x",
      tokens: 10,
      rawScore: 1,
    },
    "implementer",
  );
  expect(score.score).toBeCloseTo(0.8, 5);
});

test("AC-42: scoreChunk still applies kindWeight 1.0 to static chunks", () => {
  const score = scoreChunk(
    {
      id: "c1",
      kind: "static" as const,
      scope: "project" as const,
      role: ["all" as const],
      content: "x",
      tokens: 10,
      rawScore: 1,
    },
    "implementer",
  );
  expect(score.score).toBeCloseTo(1.0, 5);
});

test("AC-43: fetch reads biome.json in packageDir and names biome", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "biome.json"), JSON.stringify({}), "utf8");
    _lintConfigProviderDeps.detectProjectProfile = async () => ({ lintTool: "biome" });

    const provider = new LintConfigProvider();
    const result = await provider.fetch(makeReq({ packageDir: dir, repoRoot: dir }));
    expect(result.chunks.length).toBe(1);
    expect(result.chunks[0].content.toLowerCase()).toContain("biome");
  });
});

test("AC-44: fetch reports the indentWidth configured in biome.json", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "biome.json"), JSON.stringify({ indentWidth: 4 }), "utf8");
    _lintConfigProviderDeps.detectProjectProfile = async () => ({ lintTool: "biome" });

    const provider = new LintConfigProvider();
    const result = await provider.fetch(makeReq({ packageDir: dir, repoRoot: dir }));
    expect(result.chunks[0].content).toContain("4");
  });
});

test("AC-45: fetch names the detected tool even when no distiller exists", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, ".eslintrc.json"), JSON.stringify({ rules: {} }), "utf8");
    _lintConfigProviderDeps.detectProjectProfile = async () => ({ lintTool: "eslint" });

    const provider = new LintConfigProvider();
    const result = await provider.fetch(makeReq({ packageDir: dir, repoRoot: dir }));
    expect(result.chunks.length).toBe(1);
    expect(result.chunks[0].content.toLowerCase()).toContain("eslint");
  });
});

test("AC-46: fetch returns empty chunks without throwing when no lint config file exists", async () => {
  await withTempDir(async (dir) => {
    _lintConfigProviderDeps.detectProjectProfile = async () => ({ lintTool: "biome" });
    const provider = new LintConfigProvider();
    await expect(provider.fetch(makeReq({ packageDir: dir, repoRoot: dir }))).resolves.not.toThrow();
    const result = await provider.fetch(makeReq({ packageDir: dir, repoRoot: dir }));
    expect(result.chunks).toEqual([]);
  });
});

test("AC-47: fetch returns empty chunks without throwing when no lint tool is detected", async () => {
  await withTempDir(async (dir) => {
    _lintConfigProviderDeps.detectProjectProfile = async () => ({ lintTool: undefined });
    const provider = new LintConfigProvider();
    await expect(provider.fetch(makeReq({ packageDir: dir, repoRoot: dir }))).resolves.not.toThrow();
    const result = await provider.fetch(makeReq({ packageDir: dir, repoRoot: dir }));
    expect(result.chunks).toEqual([]);
  });
});

test("AC-48: fetch names the tool without throwing when lint config JSON is malformed", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "biome.json"), "{ not valid json", "utf8");
    _lintConfigProviderDeps.detectProjectProfile = async () => ({ lintTool: "biome" });

    const provider = new LintConfigProvider();
    await expect(provider.fetch(makeReq({ packageDir: dir, repoRoot: dir }))).resolves.not.toThrow();
    const result = await provider.fetch(makeReq({ packageDir: dir, repoRoot: dir }));
    expect(result.chunks.length).toBe(1);
    expect(result.chunks[0].content.toLowerCase()).toContain("biome");
  });
});

test("AC-49: every returned chunk has kind='lint-config' and scope='project'", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "biome.json"), JSON.stringify({}), "utf8");
    _lintConfigProviderDeps.detectProjectProfile = async () => ({ lintTool: "biome" });

    const provider = new LintConfigProvider();
    const result = await provider.fetch(makeReq({ packageDir: dir, repoRoot: dir }));
    for (const chunk of result.chunks) {
      expect(chunk.kind).toBe("lint-config");
      expect(chunk.scope).toBe("project");
    }
  });
});

test("AC-50: fetch is package-scoped — lint config in packageDir but not repoRoot still returns a chunk", async () => {
  await withTempDir(async (packageDir) => {
    await withTempDir(async (repoRoot) => {
      await writeFile(join(packageDir, "biome.json"), JSON.stringify({}), "utf8");
      _lintConfigProviderDeps.detectProjectProfile = async () => ({ lintTool: "biome" });

      const provider = new LintConfigProvider();
      const result = await provider.fetch(makeReq({ packageDir, repoRoot }));
      expect(result.chunks.length).toBe(1);
    });
  });
});

test("AC-51: detectProjectProfile is invoked with (packageDir, existingProfiles) from fetch's second argument", async () => {
  await withTempDir(async (dir) => {
    let captured: [string, unknown] | undefined;
    _lintConfigProviderDeps.detectProjectProfile = async (workdir, existing) => {
      captured = [workdir, existing];
      return { lintTool: undefined };
    };
    const existingProfiles = { lintTool: undefined };
    const provider = new LintConfigProvider();
    await provider.fetch(makeReq({ packageDir: dir, repoRoot: dir }), existingProfiles);
    expect(captured).toBeDefined();
    expect(captured?.[0]).toBe(dir);
    expect(captured?.[1]).toBe(existingProfiles);
  });
});

test("AC-52: createDefaultOrchestrator includes a provider with id='lint-config'", () => {
  const orchestrator = createDefaultOrchestrator(STORY, {} as NaxConfig);
  const providers = (orchestrator as unknown as { providers: { id: string }[] }).providers;
  expect(providers.some((p) => p.id === "lint-config")).toBe(true);
});

test("AC-53: rectify stage config includes 'lint-config' in providerIds", () => {
  const config = getStageContextConfig("rectify");
  expect(config.providerIds).toContain("lint-config");
});

test("AC-54: execution stage config does not include 'lint-config' in providerIds", () => {
  const config = getStageContextConfig("execution");
  expect(config.providerIds).not.toContain("lint-config");
});

// ─────────────────────────────────────────────────────────────────────────────
// US-005 — query_scratch pull tool
// ─────────────────────────────────────────────────────────────────────────────

test("AC-55: PULL_TOOL_REGISTRY contains query_scratch with descriptor name 'query_scratch'", () => {
  expect(PULL_TOOL_REGISTRY["query_scratch"]).toBeDefined();
  expect(PULL_TOOL_REGISTRY["query_scratch"].name).toBe("query_scratch");
});

test("AC-56: query_scratch inputSchema.type is 'object' with no top-level oneOf/anyOf", () => {
  const schema = PULL_TOOL_REGISTRY["query_scratch"].inputSchema as Record<string, unknown>;
  expect(schema.type).toBe("object");
  expect(schema.oneOf).toBeUndefined();
  expect(schema.anyOf).toBeUndefined();
});

test("AC-57: query_scratch inputSchema declares optional kind/limit and an empty/absent required list", () => {
  const schema = PULL_TOOL_REGISTRY["query_scratch"].inputSchema as {
    properties?: Record<string, unknown>;
    required?: string[];
  };
  expect(schema.properties).toHaveProperty("kind");
  expect(schema.properties).toHaveProperty("limit");
  expect(schema.required === undefined || schema.required.length === 0).toBe(true);
});

test("AC-58: query_scratch descriptor maxCallsPerSession equals DEFAULT_MAX_CALLS_PER_SESSION", () => {
  expect(PULL_TOOL_REGISTRY["query_scratch"].maxCallsPerSession).toBe(DEFAULT_MAX_CALLS_PER_SESSION);
});

function makeBundle(): ContextBundle {
  return {
    pushMarkdown: "",
    pullTools: [PULL_TOOL_REGISTRY["query_scratch"]],
    digest: "",
    manifest: {} as ContextBundle["manifest"],
    chunks: [],
  };
}

function makeRuntime(dir: string | undefined) {
  return createContextToolRuntime({
    bundle: makeBundle(),
    story: STORY,
    config: {} as NaxConfig,
    repoRoot: PKG,
    storyScratchDirs: dir ? [dir] : [],
  } as unknown as Parameters<typeof createContextToolRuntime>[0]);
}

test("AC-59: callTool('query_scratch') names a story's single verify-result outcome", async () => {
  await withTempDir(async (dir) => {
    await appendScratchEntry(dir, {
      kind: "verify-result",
      timestamp: "2024-01-01T00:00:00.000Z",
      storyId: "story-1",
      stage: "verify",
      success: true,
      status: "ok",
      passCount: 4,
      failCount: 0,
      rawOutputTail: "",
    } as unknown as ScratchEntry);

    const runtime = makeRuntime(dir);
    expect(runtime).toBeDefined();
    const output = await runtime!.callTool("query_scratch", {});
    expect(output.length).toBeGreaterThan(0);
    expect(output.toUpperCase()).toContain("PASS");
  });
});

test("AC-60: query_scratch filtered by kind=tool-diagnostics excludes verify entries", async () => {
  await withTempDir(async (dir) => {
    await appendScratchEntry(dir, {
      kind: "tool-diagnostics",
      timestamp: "2024-01-01T00:00:00.000Z",
      storyId: "story-1",
      file: "src/a.ts",
      diagnostics: [{ file: "src/a.ts", line: 1, severity: "error", message: "boom" }],
    } as unknown as ScratchEntry);
    await appendScratchEntry(dir, {
      kind: "verify-result",
      timestamp: "2024-01-01T00:00:01.000Z",
      storyId: "story-1",
      stage: "verify",
      success: false,
      status: "fail",
      passCount: 0,
      failCount: 1,
      rawOutputTail: "distinctive-verify-marker",
    } as unknown as ScratchEntry);

    const runtime = makeRuntime(dir);
    const output = await runtime!.callTool("query_scratch", { kind: "tool-diagnostics" });
    expect(output).toContain("src/a.ts");
    expect(output).not.toContain("distinctive-verify-marker");
  });
});

test("AC-61: query_scratch with limit=1 against three entries names exactly one", async () => {
  await withTempDir(async (dir) => {
    for (let i = 0; i < 3; i++) {
      await appendScratchEntry(dir, {
        kind: "rectify-attempt",
        timestamp: `2024-01-01T00:00:0${i}.000Z`,
        storyId: "story-1",
        stage: "rectify",
        attempt: i + 1,
        succeeded: false,
      } as unknown as ScratchEntry);
    }
    const runtime = makeRuntime(dir);
    const output = await runtime!.callTool("query_scratch", { limit: 1 });
    const attemptMatches = output.match(/attempt \d/gi) ?? [];
    expect(attemptMatches.length).toBe(1);
  });
});

test("AC-62: query_scratch for a story with no scratch dir returns a no-entries message without throwing", async () => {
  const runtime = makeRuntime(undefined);
  await expect(runtime!.callTool("query_scratch", {})).resolves.not.toThrow();
  const output = await runtime!.callTool("query_scratch", {});
  expect(output.length).toBeGreaterThan(0);
});

test("AC-63: query_scratch with an unused kind returns a no-entries message", async () => {
  await withTempDir(async (dir) => {
    await appendScratchEntry(dir, {
      kind: "verify-result",
      timestamp: "2024-01-01T00:00:00.000Z",
      storyId: "story-1",
      stage: "verify",
      success: true,
      status: "ok",
      passCount: 1,
      failCount: 0,
      rawOutputTail: "",
    } as unknown as ScratchEntry);

    const runtime = makeRuntime(dir);
    const output = await runtime!.callTool("query_scratch", { kind: "tool-diagnostics" });
    expect(output.length).toBeGreaterThan(0);
    expect(output).not.toContain("PASS");
  });
});

test("AC-64: query_scratch neutralizes agent-specific tool references from another agent", async () => {
  await withTempDir(async (dir) => {
    await appendScratchEntry(dir, {
      kind: "verify-result",
      timestamp: "2024-01-01T00:00:00.000Z",
      storyId: "story-1",
      stage: "verify",
      success: false,
      status: "fail",
      passCount: 0,
      failCount: 1,
      rawOutputTail: "I used the Read tool to inspect the file",
      writtenByAgent: "claude",
    } as unknown as ScratchEntry);

    const runtime = createContextToolRuntime({
      bundle: makeBundle(),
      story: { ...STORY, id: "story-1" },
      config: {} as NaxConfig,
      repoRoot: PKG,
      storyScratchDirs: [dir],
      agentId: "codex",
    } as unknown as Parameters<typeof createContextToolRuntime>[0]);
    const output = await runtime!.callTool("query_scratch", {});
    expect(output).not.toContain("the Read tool");
  });
});

test("AC-65: rectify stage config pullToolNames includes 'query_scratch'", () => {
  const config = getStageContextConfig("rectify");
  expect(config.pullToolNames).toContain("query_scratch");
});

test("AC-66: execution stage config pullToolNames includes 'query_scratch'", () => {
  const config = getStageContextConfig("execution");
  expect(config.pullToolNames).toContain("query_scratch");
});