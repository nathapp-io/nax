/**
 * Context Stage — rules-integrity fallback (gap-analysis finding 1)
 *
 * When the canonical rules store fails the neutrality linter, orchestrator.ts
 * escalates (re-throws NeutralityLintError instead of soft-skipping). This
 * verifies runV2Path's catch actually falls back to the v1 context path on
 * that specific error — not just logs and leaves ctx.contextMarkdown unset,
 * which would be a silent no-context proceed, strictly worse than the
 * original bug.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { NeutralityLintError } from "@/context";
import type { PipelineContext } from "@/pipeline";
// _contextStageDeps is test-only and not re-exported from the pipeline/stages barrel.
import { _contextStageDeps, contextStage } from "@/pipeline/stages/context";
import { cleanupTempDir, makeNaxConfig, makeTempDir } from "@test/helpers";

let origCreateOrchestrator: typeof _contextStageDeps.createOrchestrator;
let origReadDigest: typeof _contextStageDeps.readDigest;
let origWriteDigest: typeof _contextStageDeps.writeDigest;

let tmpDir: string;

beforeEach(() => {
  tmpDir = makeTempDir("nax-ctx-rules-fallback-test-");
  origCreateOrchestrator = _contextStageDeps.createOrchestrator;
  origReadDigest = _contextStageDeps.readDigest;
  origWriteDigest = _contextStageDeps.writeDigest;
  _contextStageDeps.readDigest = async () => "";
  _contextStageDeps.writeDigest = async () => {};
});

afterEach(() => {
  _contextStageDeps.createOrchestrator = origCreateOrchestrator;
  _contextStageDeps.readDigest = origReadDigest;
  _contextStageDeps.writeDigest = origWriteDigest;
  cleanupTempDir(tmpDir);
});

function makeCtx(overrides: Partial<PipelineContext> = {}): PipelineContext {
  return {
    config: makeNaxConfig({
      context: {
        v2: { enabled: true },
        featureEngine: { enabled: false, budgetTokens: 8_000 },
      },
    }),
    rootConfig: {} as PipelineContext["rootConfig"],
    prd: { userStories: [] } as unknown as PipelineContext["prd"],
    story: { id: "US-001", workdir: "" } as PipelineContext["story"],
    stories: [],
    routing: {} as PipelineContext["routing"],
    projectDir: tmpDir,
    workdir: tmpDir,
    hooks: {} as PipelineContext["hooks"],
    sessionScratchDir: join(tmpDir, "sessions", "sess-001"),
    sessionId: "sess-001",
    ...overrides,
  } as PipelineContext;
}

describe("context stage — rules-integrity fallback", () => {
  test("falls back to the v1 path (contextMarkdown gets set) when assemble() throws NeutralityLintError", async () => {
    _contextStageDeps.createOrchestrator = () =>
      ({
        async assemble() {
          throw new NeutralityLintError([
            {
              file: "curator-suggestions.md",
              lineNumber: 1,
              line: "IMPORTANT:",
              ruleId: "important-shouting",
              pattern: "shouting-style IMPORTANT:",
            },
          ]);
        },
        rebuildForAgent: () => {
          throw new Error("not used in this test");
        },
      }) as unknown as ReturnType<typeof _contextStageDeps.createOrchestrator>;

    const ctx = makeCtx();
    await contextStage.execute(ctx);

    // v1's runV1Path always sets contextMarkdown (possibly to "" on soft
    // failure) — its presence is the observable signal the fallback ran,
    // as opposed to the pre-fix behavior where neither path populated it.
    expect(ctx.contextMarkdown).toBeDefined();
    // v2 must not be left half-populated from the failed attempt.
    expect(ctx.contextBundle).toBeUndefined();
  });

  test("a non-lint v2 failure still soft-skips (contextMarkdown NOT forced via v1 fallback)", async () => {
    _contextStageDeps.createOrchestrator = () =>
      ({
        async assemble() {
          throw new Error("simulated unrelated provider failure");
        },
        rebuildForAgent: () => {
          throw new Error("not used in this test");
        },
      }) as unknown as ReturnType<typeof _contextStageDeps.createOrchestrator>;

    const ctx = makeCtx();
    await contextStage.execute(ctx);

    // Existing behavior for non-lint failures is unchanged: soft warn, no
    // v1 fallback forced.
    expect(ctx.contextMarkdown).toBeUndefined();
  });
});
