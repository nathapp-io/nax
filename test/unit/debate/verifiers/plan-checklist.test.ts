/**
 * Tests for planChecklistVerifier — US-004
 *
 * Covers all acceptance criteria:
 * - AC1: Registration and parse failure handling
 * - AC2: Five mechanical checks with documented severities
 * - AC3: Outcome determination based on blockers and onBlocker policy
 * - AC5: Artifact writing to disk
 * - AC6: onBlocker policy behavior
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PathLike } from "node:fs";
import { makeMockCallContext, makeMockRuntime } from "@test/helpers";
import type { PostDebateVerifierContext } from "@/debate";
import { _planChecklistDeps, planChecklistVerifier, resolvePostDebateVerifier } from "@/debate";
import type { FactsManifest } from "@/debate/facts-manifest";
import type { SelectorResult } from "@/debate/selectors/types";
import type { DebateStageConfig } from "@/debate/types";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/**
 * Returns a JSON string representing a valid minimal PRD story.
 * Must satisfy validatePlanOutput: id, title, description, non-empty acceptanceCriteria,
 * and routing.complexity.
 */
const makeValidStory = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "US-001",
  title: "Test Story",
  description: "A test description.",
  acceptanceCriteria: ["AC1: Does something"],
  routing: { complexity: "simple" },
  ...overrides,
});

const makeValidPRDJson = (stories: Record<string, unknown>[] = [makeValidStory()]): string =>
  JSON.stringify({ userStories: stories });

const makeManifestJson = (overrides: Partial<FactsManifest> = {}): string =>
  JSON.stringify({ repoFacts: [], specClaims: [], gaps: [], ...overrides });

const RUN_ID = "test-run-001";

const makeVerifierContext = (overrides: Partial<PostDebateVerifierContext> = {}): PostDebateVerifierContext => {
  const runtime = makeMockRuntime();
  Object.defineProperty(runtime, "runId", { value: RUN_ID });
  return {
    storyId: "US-001",
    stage: "plan",
    stageConfig: {
      enabled: true,
      sessionMode: "one-shot",
      rounds: 1,
      resolver: { type: "synthesis" },
    } as DebateStageConfig,
    selectorResult: {
      outcome: "passed",
      output: makeValidPRDJson(),
    } as SelectorResult,
    workdir: "/test/workdir",
    ctx: makeMockCallContext({
      runtime,
      packageDir: "/test/workdir",
      agentName: "claude",
      storyId: "US-001",
      featureName: "test-feature",
    }),
    ...overrides,
  };
};

const EXPECTED_ARTIFACT_PATH = "/test/workdir/.nax/runs/test-run-001/plan/US-001/spec-deltas.md";

// ---------------------------------------------------------------------------
// Dep mocking
// ---------------------------------------------------------------------------

let capturedWrites: Array<{ path: string; content: string }> = [];
let existsSyncImpl: (path: string) => boolean = () => true;
let readFileImpl: (path: string) => Promise<string | null> = async () => null;

let origExistsSync: typeof _planChecklistDeps.existsSync;
let origWrite: typeof _planChecklistDeps.write;
let origReadFile: typeof _planChecklistDeps.readFile;

beforeEach(() => {
  capturedWrites = [];
  existsSyncImpl = () => true;
  readFileImpl = async () => null;

  origExistsSync = _planChecklistDeps.existsSync;
  origWrite = _planChecklistDeps.write;
  origReadFile = _planChecklistDeps.readFile;

  _planChecklistDeps.existsSync = (p: PathLike) => existsSyncImpl(String(p));
  _planChecklistDeps.write = async (p: string, data: string) => {
    capturedWrites.push({ path: p, content: data });
    return 0;
  };
  _planChecklistDeps.readFile = async (p: string) => readFileImpl(p);
});

afterEach(() => {
  _planChecklistDeps.existsSync = origExistsSync;
  _planChecklistDeps.write = origWrite;
  _planChecklistDeps.readFile = origReadFile;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("planChecklistVerifier (US-004)", () => {
  describe("AC1: Registration and parse failure", () => {
    test("is registered under 'plan-checklist' kind", () => {
      const verifier = resolvePostDebateVerifier("plan-checklist");
      expect(typeof verifier).toBe("function");
    });

    test("returns outcome === 'failed' when selectorResult.output is invalid JSON", async () => {
      const ctx = makeVerifierContext({
        selectorResult: {
          outcome: "passed",
          output: "not valid json at all",
        } as SelectorResult,
      });
      const result = await planChecklistVerifier(ctx);
      expect(result.outcome).toBe("failed");
    });

    test("returns outcome === 'failed' when selectorResult.output is valid JSON but not a PRD", async () => {
      const ctx = makeVerifierContext({
        selectorResult: {
          outcome: "passed",
          output: JSON.stringify({ notAPrd: true }),
        } as SelectorResult,
      });
      const result = await planChecklistVerifier(ctx);
      expect(result.outcome).toBe("failed");
    });

    test("returns outcome === 'failed' when selectorResult.output is missing required PRD fields", async () => {
      const ctx = makeVerifierContext({
        selectorResult: {
          outcome: "passed",
          output: JSON.stringify({ project: "test", feature: "test" }),
        } as SelectorResult,
      });
      const result = await planChecklistVerifier(ctx);
      expect(result.outcome).toBe("failed");
    });
  });

  describe("AC2: Five mechanical checks", () => {
    describe("files-exist check", () => {
      test("emits blocker finding for missing contextFiles entry on disk", async () => {
        existsSyncImpl = () => false;

        const ctx = makeVerifierContext({
          selectorResult: {
            outcome: "passed",
            output: makeValidPRDJson([makeValidStory({ contextFiles: [{ path: "src/missing.ts", factId: "F-001" }] })]),
          } as SelectorResult,
        });

        const result = await planChecklistVerifier(ctx);
        const findings = result.findings as Array<Record<string, unknown>>;
        const filesExist = findings?.filter((f) => f.checklistItem === "files-exist" && f.severity === "blocker");
        expect(filesExist?.length).toBeGreaterThan(0);
        expect(filesExist?.[0].path).toBe("src/missing.ts");
      });

      test("emits no files-exist finding when all contextFiles exist", async () => {
        existsSyncImpl = () => true;

        const ctx = makeVerifierContext({
          selectorResult: {
            outcome: "passed",
            output: makeValidPRDJson([
              makeValidStory({
                contextFiles: [{ path: "src/exists.ts" }],
                verifiedBy: { kind: "test", anchor: "test-anchor", factIds: [] },
              }),
            ]),
          } as SelectorResult,
        });

        const result = await planChecklistVerifier(ctx);
        const findings = result.findings as Array<Record<string, unknown>>;
        const filesExist = findings?.filter((f) => f.checklistItem === "files-exist");
        expect(filesExist?.length ?? 0).toBe(0);
      });
    });

    describe("ac-anchored check", () => {
      test("emits major finding for story with no verifiedBy anchor and intent not true", async () => {
        const ctx = makeVerifierContext({
          selectorResult: {
            outcome: "passed",
            output: makeValidPRDJson([makeValidStory()]), // no verifiedBy, no intent
          } as SelectorResult,
        });

        const result = await planChecklistVerifier(ctx);
        const findings = result.findings as Array<Record<string, unknown>>;
        const acAnchored = findings?.filter((f) => f.checklistItem === "ac-anchored" && f.severity === "major");
        expect(acAnchored?.length).toBeGreaterThan(0);
      });

      test("emits no ac-anchored finding for story with verifiedBy anchor", async () => {
        const ctx = makeVerifierContext({
          selectorResult: {
            outcome: "passed",
            output: makeValidPRDJson([
              makeValidStory({ verifiedBy: { kind: "test", anchor: "test-name", factIds: [] } }),
            ]),
          } as SelectorResult,
        });

        const result = await planChecklistVerifier(ctx);
        const findings = result.findings as Array<Record<string, unknown>>;
        const acAnchored = findings?.filter((f) => f.checklistItem === "ac-anchored");
        expect(acAnchored?.length ?? 0).toBe(0);
      });

      test("emits no ac-anchored finding for story with intent=true", async () => {
        const ctx = makeVerifierContext({
          selectorResult: {
            outcome: "passed",
            output: makeValidPRDJson([makeValidStory({ intent: true })]),
          } as SelectorResult,
        });

        const result = await planChecklistVerifier(ctx);
        const findings = result.findings as Array<Record<string, unknown>>;
        const acAnchored = findings?.filter((f) => f.checklistItem === "ac-anchored");
        expect(acAnchored?.length ?? 0).toBe(0);
      });
    });

    describe("claims-cited check", () => {
      test("emits major finding when citation rate is below default threshold (0.5)", async () => {
        readFileImpl = async () =>
          makeManifestJson({
            specClaims: [
              {
                id: "S-001",
                specSpan: "line 1",
                claim: "claim 1",
                kind: "factual",
                verification: { status: "unverified" },
              },
              {
                id: "S-002",
                specSpan: "line 2",
                claim: "claim 2",
                kind: "factual",
                verification: { status: "unverified" },
              },
            ],
          });

        const ctx = makeVerifierContext({
          selectorResult: {
            outcome: "passed",
            output: makeValidPRDJson([makeValidStory({ verifiedBy: { kind: "test", anchor: "t", factIds: [] } })]),
          } as SelectorResult,
        });

        const result = await planChecklistVerifier(ctx);
        const findings = result.findings as Array<Record<string, unknown>>;
        const claimsCited = findings?.filter((f) => f.checklistItem === "claims-cited" && f.severity === "major");
        expect(claimsCited?.length).toBeGreaterThan(0);
      });

      test("emits no claims-cited finding when citation rate meets threshold", async () => {
        readFileImpl = async () =>
          makeManifestJson({
            specClaims: [
              {
                id: "S-001",
                specSpan: "line 1",
                claim: "claim 1",
                kind: "factual",
                verification: { status: "verified" },
              },
              {
                id: "S-002",
                specSpan: "line 2",
                claim: "claim 2",
                kind: "factual",
                verification: { status: "verified" },
              },
            ],
          });

        const ctx = makeVerifierContext({
          selectorResult: {
            outcome: "passed",
            output: makeValidPRDJson([makeValidStory({ verifiedBy: { kind: "test", anchor: "t", factIds: [] } })]),
          } as SelectorResult,
        });

        const result = await planChecklistVerifier(ctx);
        const findings = result.findings as Array<Record<string, unknown>>;
        const claimsCited = findings?.filter((f) => f.checklistItem === "claims-cited");
        expect(claimsCited?.length ?? 0).toBe(0);
      });
    });

    describe("no-contradictions check", () => {
      test("emits blocker finding when PRD contextFile references contradicted factId in manifest", async () => {
        readFileImpl = async () =>
          makeManifestJson({
            specClaims: [
              {
                id: "S-001",
                specSpan: "line 10",
                claim: "extends schema",
                kind: "factual",
                verification: { status: "contradicted", evidence: "Schema does not extend" },
              },
            ],
          });

        const ctx = makeVerifierContext({
          selectorResult: {
            outcome: "passed",
            output: makeValidPRDJson([
              makeValidStory({
                contextFiles: [{ path: "src/file.ts", factId: "S-001" }],
                verifiedBy: { kind: "test", anchor: "t", factIds: [] },
              }),
            ]),
          } as SelectorResult,
        });

        const result = await planChecklistVerifier(ctx);
        const findings = result.findings as Array<Record<string, unknown>>;
        const contradictions = findings?.filter(
          (f) => f.checklistItem === "no-contradictions" && f.severity === "blocker",
        );
        expect(contradictions?.length).toBeGreaterThan(0);
        expect(contradictions?.[0].specId).toBe("S-001");
      });

      test("emits no finding when no spec claims are contradicted", async () => {
        readFileImpl = async () =>
          makeManifestJson({
            specClaims: [
              {
                id: "S-001",
                specSpan: "line 10",
                claim: "extends schema",
                kind: "factual",
                verification: { status: "verified" },
              },
            ],
          });

        const ctx = makeVerifierContext({
          selectorResult: {
            outcome: "passed",
            output: makeValidPRDJson([makeValidStory({ verifiedBy: { kind: "test", anchor: "t", factIds: [] } })]),
          } as SelectorResult,
        });

        const result = await planChecklistVerifier(ctx);
        const findings = result.findings as Array<Record<string, unknown>>;
        const contradictions = findings?.filter((f) => f.checklistItem === "no-contradictions");
        expect(contradictions?.length ?? 0).toBe(0);
      });
    });

    describe("spec-coverage check", () => {
      test("emits major finding for unverified factual spec claims in manifest", async () => {
        readFileImpl = async () =>
          makeManifestJson({
            specClaims: [
              {
                id: "S-001",
                specSpan: "line 10",
                claim: "uses retry middleware",
                kind: "factual",
                verification: { status: "unverified" },
              },
            ],
          });

        const ctx = makeVerifierContext({
          selectorResult: {
            outcome: "passed",
            output: makeValidPRDJson([makeValidStory({ verifiedBy: { kind: "test", anchor: "t", factIds: [] } })]),
          } as SelectorResult,
        });

        const result = await planChecklistVerifier(ctx);
        const findings = result.findings as Array<Record<string, unknown>>;
        const coverage = findings?.filter(
          (f) => f.checklistItem === "spec-coverage" && f.severity === "major" && f.specId === "S-001",
        );
        expect(coverage?.length).toBeGreaterThan(0);
      });

      test("emits no spec-coverage finding for intent spec claims regardless of verification", async () => {
        readFileImpl = async () =>
          makeManifestJson({
            specClaims: [
              {
                id: "S-001",
                specSpan: "line 10",
                claim: "maintains backward compatibility",
                kind: "intent",
                verification: { status: "unverified" },
              },
            ],
          });

        const ctx = makeVerifierContext({
          selectorResult: {
            outcome: "passed",
            output: makeValidPRDJson([makeValidStory({ verifiedBy: { kind: "test", anchor: "t", factIds: [] } })]),
          } as SelectorResult,
        });

        const result = await planChecklistVerifier(ctx);
        const findings = result.findings as Array<Record<string, unknown>>;
        const coverage = findings?.filter((f) => f.checklistItem === "spec-coverage" && f.specId === "S-001");
        expect(coverage?.length ?? 0).toBe(0);
      });
    });
  });

  describe("AC3: Outcome determination", () => {
    test("returns outcome === 'failed' when blocker findings exist (onBlocker 'block' or default)", async () => {
      existsSyncImpl = () => false; // triggers files-exist blocker
      const blockerSelectorResult = {
        outcome: "passed",
        output: makeValidPRDJson([makeValidStory({ contextFiles: [{ path: "src/missing.ts", factId: "F-001" }] })]),
      } as SelectorResult;

      // Sub-scenario 1: explicit onBlocker: "block"
      const ctx1 = makeVerifierContext({
        selectorResult: blockerSelectorResult,
        stageConfig: {
          enabled: true,
          sessionMode: "one-shot",
          rounds: 1,
          resolver: { type: "synthesis" },
          postDebateVerifier: { kind: "plan-checklist", onBlocker: "block" },
        } as DebateStageConfig,
      });
      expect((await planChecklistVerifier(ctx1)).outcome).toBe("failed");

      // Sub-scenario 2: onBlocker undefined (defaults to block)
      const ctx2 = makeVerifierContext({
        selectorResult: blockerSelectorResult,
        stageConfig: {
          enabled: true,
          sessionMode: "one-shot",
          rounds: 1,
          resolver: { type: "synthesis" },
          postDebateVerifier: { kind: "plan-checklist" },
        } as DebateStageConfig,
      });
      expect((await planChecklistVerifier(ctx2)).outcome).toBe("failed");
    });

    test("returns outcome === 'passed' when no blocker findings are present", async () => {
      existsSyncImpl = () => true;

      // Story with verifiedBy avoids ac-anchored major; no contextFiles with bad factIds.
      const ctx = makeVerifierContext({
        selectorResult: {
          outcome: "passed",
          output: makeValidPRDJson([makeValidStory({ verifiedBy: { kind: "test", anchor: "t", factIds: [] } })]),
        } as SelectorResult,
      });

      const result = await planChecklistVerifier(ctx);
      expect(result.outcome).toBe("passed");
    });
  });

  describe("AC5: Artifact writing", () => {
    test("writes artifact and includes path in output when blockers present; no artifact when no blockers", async () => {
      // Sub-scenario 1: blockers present — writes file and returns path
      existsSyncImpl = () => false;
      const blockerCtx = makeVerifierContext({
        selectorResult: {
          outcome: "passed",
          output: makeValidPRDJson([makeValidStory({ contextFiles: [{ path: "src/missing.ts", factId: "F-001" }] })]),
        } as SelectorResult,
      });
      const result1 = await planChecklistVerifier(blockerCtx);
      expect(capturedWrites).toHaveLength(1);
      expect(capturedWrites[0].path).toBe(EXPECTED_ARTIFACT_PATH);
      expect(result1.output).toBe(EXPECTED_ARTIFACT_PATH);

      // Sub-scenario 2: no blockers — no artifact written
      capturedWrites.length = 0;
      existsSyncImpl = () => true;
      const noBlockerCtx = makeVerifierContext({
        selectorResult: {
          outcome: "passed",
          output: makeValidPRDJson([makeValidStory({ verifiedBy: { kind: "test", anchor: "t", factIds: [] } })]),
        } as SelectorResult,
      });
      await planChecklistVerifier(noBlockerCtx);
      expect(capturedWrites).toHaveLength(0);
    });
  });

  describe("AC6: onBlocker policy", () => {
    test("tag-expert: outcome passed despite blockers; artifact path as downstream signal", async () => {
      existsSyncImpl = () => false;

      const ctx = makeVerifierContext({
        selectorResult: {
          outcome: "passed",
          output: makeValidPRDJson([makeValidStory({ contextFiles: [{ path: "src/missing.ts", factId: "F-001" }] })]),
        } as SelectorResult,
        stageConfig: {
          enabled: true,
          sessionMode: "one-shot",
          rounds: 1,
          resolver: { type: "synthesis" },
          postDebateVerifier: { kind: "plan-checklist", onBlocker: "tag-expert" },
        } as DebateStageConfig,
      });

      const result = await planChecklistVerifier(ctx);
      expect(result.outcome).toBe("passed");
      expect(result.output).toBe(EXPECTED_ARTIFACT_PATH);
    });
  });
});
