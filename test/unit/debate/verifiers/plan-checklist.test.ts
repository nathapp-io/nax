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

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { planChecklistVerifier, _planChecklistDeps, resolvePostDebateVerifier } from "@/debate";
import type { PostDebateVerifierContext } from "@/debate";
import type { SelectorResult } from "@/debate/selectors/types";
import type { DebateStageConfig } from "@/debate/types";
import type { CallContext } from "@/operations/types";
import type { FactsManifest } from "@/debate/facts-manifest";

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

const makeVerifierContext = (overrides: Partial<PostDebateVerifierContext> = {}): PostDebateVerifierContext => ({
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
  ctx: {
    runtime: { runId: "test-run-001" } as any,
    packageView: {} as any,
    packageDir: "/test/workdir",
    agentName: "claude",
    storyId: "US-001",
    featureName: "test-feature",
  } as CallContext,
  ...overrides,
});

const EXPECTED_ARTIFACT_PATH =
  "/test/workdir/.nax/runs/test-run-001/plan/US-001/spec-deltas.md";

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

  _planChecklistDeps.existsSync = (p: string) => existsSyncImpl(p);
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
                    output: makeValidPRDJson([
              makeValidStory({ contextFiles: [{ path: "src/missing.ts", factId: "F-001" }] }),
            ]),
          } as SelectorResult,
        });

        const result = await planChecklistVerifier(ctx);
        const findings = result.findings as Array<Record<string, unknown>>;
        const filesExist = findings?.filter(
          (f) => f.checklistItem === "files-exist" && f.severity === "blocker",
        );
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
        const acAnchored = findings?.filter(
          (f) => f.checklistItem === "ac-anchored" && f.severity === "major",
        );
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
                    output: makeValidPRDJson([
              makeValidStory({ verifiedBy: { kind: "test", anchor: "t", factIds: [] } }),
            ]),
          } as SelectorResult,
        });

        const result = await planChecklistVerifier(ctx);
        const findings = result.findings as Array<Record<string, unknown>>;
        const claimsCited = findings?.filter(
          (f) => f.checklistItem === "claims-cited" && f.severity === "major",
        );
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
                    output: makeValidPRDJson([
              makeValidStory({ verifiedBy: { kind: "test", anchor: "t", factIds: [] } }),
            ]),
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
                    output: makeValidPRDJson([
              makeValidStory({ verifiedBy: { kind: "test", anchor: "t", factIds: [] } }),
            ]),
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
                    output: makeValidPRDJson([
              makeValidStory({ verifiedBy: { kind: "test", anchor: "t", factIds: [] } }),
            ]),
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
                    output: makeValidPRDJson([
              makeValidStory({ verifiedBy: { kind: "test", anchor: "t", factIds: [] } }),
            ]),
          } as SelectorResult,
        });

        const result = await planChecklistVerifier(ctx);
        const findings = result.findings as Array<Record<string, unknown>>;
        const coverage = findings?.filter(
          (f) => f.checklistItem === "spec-coverage" && f.specId === "S-001",
        );
        expect(coverage?.length ?? 0).toBe(0);
      });
    });
  });

  describe("AC3: Outcome determination", () => {
    test("returns outcome === 'failed' when blocker findings exist and onBlocker is 'block'", async () => {
      existsSyncImpl = () => false; // triggers files-exist blocker

      const ctx = makeVerifierContext({
        selectorResult: {
          outcome: "passed",
                output: makeValidPRDJson([
            makeValidStory({ contextFiles: [{ path: "src/missing.ts", factId: "F-001" }] }),
          ]),
        } as SelectorResult,
        stageConfig: {
          enabled: true,
          sessionMode: "one-shot",
          rounds: 1,
          resolver: { type: "synthesis" },
          postDebateVerifier: { kind: "plan-checklist", onBlocker: "block" },
        } as DebateStageConfig,
      });

      const result = await planChecklistVerifier(ctx);
      expect(result.outcome).toBe("failed");
    });

    test("returns outcome === 'failed' when blocker findings exist and onBlocker is undefined (defaults to block)", async () => {
      existsSyncImpl = () => false;

      const ctx = makeVerifierContext({
        selectorResult: {
          outcome: "passed",
                output: makeValidPRDJson([
            makeValidStory({ contextFiles: [{ path: "src/missing.ts", factId: "F-001" }] }),
          ]),
        } as SelectorResult,
        stageConfig: {
          enabled: true,
          sessionMode: "one-shot",
          rounds: 1,
          resolver: { type: "synthesis" },
          postDebateVerifier: { kind: "plan-checklist" }, // no onBlocker
        } as DebateStageConfig,
      });

      const result = await planChecklistVerifier(ctx);
      expect(result.outcome).toBe("failed");
    });

    test("returns outcome === 'passed' when no blocker findings are present", async () => {
      existsSyncImpl = () => true;

      // Story with verifiedBy avoids ac-anchored major; no contextFiles with bad factIds.
      const ctx = makeVerifierContext({
        selectorResult: {
          outcome: "passed",
                output: makeValidPRDJson([
            makeValidStory({ verifiedBy: { kind: "test", anchor: "t", factIds: [] } }),
          ]),
        } as SelectorResult,
      });

      const result = await planChecklistVerifier(ctx);
      expect(result.outcome).toBe("passed");
    });
  });

  describe("AC5: Artifact writing", () => {
    test("writes spec-deltas.md to .nax/runs/<runId>/plan/<storyId>/ when blockers present", async () => {
      existsSyncImpl = () => false;

      const ctx = makeVerifierContext({
        selectorResult: {
          outcome: "passed",
                output: makeValidPRDJson([
            makeValidStory({ contextFiles: [{ path: "src/missing.ts", factId: "F-001" }] }),
          ]),
        } as SelectorResult,
      });

      await planChecklistVerifier(ctx);
      expect(capturedWrites).toHaveLength(1);
      expect(capturedWrites[0].path).toBe(EXPECTED_ARTIFACT_PATH);
    });

    test("includes artifact path in returned output field when blockers present", async () => {
      existsSyncImpl = () => false;

      const ctx = makeVerifierContext({
        selectorResult: {
          outcome: "passed",
                output: makeValidPRDJson([
            makeValidStory({ contextFiles: [{ path: "src/missing.ts", factId: "F-001" }] }),
          ]),
        } as SelectorResult,
      });

      const result = await planChecklistVerifier(ctx);
      expect(result.output).toBe(EXPECTED_ARTIFACT_PATH);
    });

    test("does not write artifact when no blocker findings are present", async () => {
      existsSyncImpl = () => true;

      const ctx = makeVerifierContext({
        selectorResult: {
          outcome: "passed",
                output: makeValidPRDJson([
            makeValidStory({ verifiedBy: { kind: "test", anchor: "t", factIds: [] } }),
          ]),
        } as SelectorResult,
      });

      await planChecklistVerifier(ctx);
      expect(capturedWrites).toHaveLength(0);
    });
  });

  describe("AC6: onBlocker policy", () => {
    test("returns outcome === 'passed' when onBlocker === 'tag-expert' despite blocker findings", async () => {
      existsSyncImpl = () => false;

      const ctx = makeVerifierContext({
        selectorResult: {
          outcome: "passed",
                output: makeValidPRDJson([
            makeValidStory({ contextFiles: [{ path: "src/missing.ts", factId: "F-001" }] }),
          ]),
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
    });

    test("emits artifact path as downstream signal when onBlocker === 'tag-expert'", async () => {
      existsSyncImpl = () => false;

      const ctx = makeVerifierContext({
        selectorResult: {
          outcome: "passed",
                output: makeValidPRDJson([
            makeValidStory({ contextFiles: [{ path: "src/missing.ts", factId: "F-001" }] }),
          ]),
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
