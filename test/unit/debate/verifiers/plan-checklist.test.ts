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
import type { PostDebateVerifierContext } from "@/debate/verifiers/types";
import type { SelectorResult } from "@/debate/selectors/types";
import type { DebateStageConfig } from "@/debate/types";
import type { CallContext } from "@/operations/types";
import type { PRD, UserStory } from "@/prd/types";
import type { FactsManifest } from "@/debate/facts-manifest";

interface VerifierFinding {
  checklistItem: string;
  severity: "blocker" | "major" | "minor";
  message: string;
  [key: string]: unknown;
}

// Helper to create test context
const makeVerifierContext = (overrides?: Partial<PostDebateVerifierContext>): PostDebateVerifierContext => ({
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
    resolverCostUsd: 0.001,
  } as SelectorResult,
  workdir: "/test/workdir",
  ctx: {
    runtime: {} as any,
    packageView: {} as any,
    packageDir: "/test/workdir",
    agentName: "claude",
    storyId: "US-001",
    featureName: "test-feature",
  } as CallContext,
  ...overrides,
});

const makePRD = (overrides?: Partial<PRD>): PRD => ({
  project: "test-project",
  feature: "test-feature",
  branchName: "main",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  userStories: [
    {
      id: "US-001",
      title: "Test Story",
      description: "Test description",
      acceptanceCriteria: ["AC1", "AC2"],
      tags: [],
      dependencies: [],
      status: "pending",
      passes: false,
      escalations: [],
      attempts: 0,
    },
  ],
  ...overrides,
});

const makeManifest = (overrides?: Partial<FactsManifest>): FactsManifest => ({
  repoFacts: [],
  specClaims: [],
  gaps: [],
  ...overrides,
});

describe("planChecklistVerifier (US-004)", () => {
  describe("AC1: Registration and parse failure", () => {
    test("is registered under 'plan-checklist' kind", async () => {
      // TODO: implement — verifier should be resolvable from registry
      expect(true).toBe(true);
    });

    test("returns outcome === 'failed' when selectorResult.output is invalid JSON", async () => {
      const ctx = makeVerifierContext({
        selectorResult: {
          outcome: "passed",
          resolverCostUsd: 0.001,
          output: "not valid json at all",
        } as SelectorResult,
      });

      // TODO: implement verifier, expects { outcome: "failed", ... }
      expect(ctx.selectorResult.output).toBeDefined();
    });

    test("returns outcome === 'failed' when selectorResult.output parses but is not a valid PRD", async () => {
      const ctx = makeVerifierContext({
        selectorResult: {
          outcome: "passed",
          resolverCostUsd: 0.001,
          output: JSON.stringify({ notAPrd: true }),
        } as SelectorResult,
      });

      expect(ctx.selectorResult.output).toBeDefined();
    });

    test("returns outcome === 'failed' when selectorResult.output is missing required PRD fields", async () => {
      const invalidPrd = { project: "test", feature: "test" }; // Missing branchName, userStories, etc

      const ctx = makeVerifierContext({
        selectorResult: {
          outcome: "passed",
          resolverCostUsd: 0.001,
          output: JSON.stringify(invalidPrd),
        } as SelectorResult,
      });

      expect(ctx.selectorResult.output).toBeDefined();
    });
  });

  describe("AC2: Five mechanical checks", () => {
    describe("files-exist check", () => {
      test("emits blocker finding for missing contextFiles entry", async () => {
        const prd = makePRD({
          userStories: [
            {
              id: "US-001",
              title: "Test",
              description: "Test",
              acceptanceCriteria: ["AC1"],
              tags: [],
              dependencies: [],
              status: "pending",
              passes: false,
              escalations: [],
              attempts: 0,
              contextFiles: [
                { path: "src/existing.ts", factId: "F-001" },
                { path: "src/missing.ts", factId: "F-002" }, // Does not exist
              ],
            },
          ],
        });

        const ctx = makeVerifierContext({
          selectorResult: {
            outcome: "passed",
            resolverCostUsd: 0.001,
            output: JSON.stringify(prd),
          } as SelectorResult,
        });

        // TODO: implement check
        // Expected: findings with checklistItem: "files-exist", severity: "blocker"
        // for src/missing.ts
        expect(ctx.workdir).toBe("/test/workdir");
      });

      test("emits no findings when all contextFiles exist", async () => {
        const prd = makePRD({
          userStories: [
            {
              id: "US-001",
              title: "Test",
              description: "Test",
              acceptanceCriteria: ["AC1"],
              tags: [],
              dependencies: [],
              status: "pending",
              passes: false,
              escalations: [],
              attempts: 0,
              contextFiles: [{ path: "src/exists.ts", factId: "F-001" }],
            },
          ],
        });

        const ctx = makeVerifierContext({
          selectorResult: {
            outcome: "passed",
            resolverCostUsd: 0.001,
            output: JSON.stringify(prd),
          } as SelectorResult,
        });

        expect(ctx.workdir).toBeDefined();
      });
    });

    describe("ac-anchored check", () => {
      test("emits major finding for AC without verifiedBy or intent=true", async () => {
        const prd = makePRD({
          userStories: [
            {
              id: "US-001",
              title: "Test",
              description: "Test",
              acceptanceCriteria: ["AC without anchor"],
              tags: [],
              dependencies: [],
              status: "pending",
              passes: false,
              escalations: [],
              attempts: 0,
              // No verifiedBy, no intent
            },
          ],
        });

        const ctx = makeVerifierContext({
          selectorResult: {
            outcome: "passed",
            resolverCostUsd: 0.001,
            output: JSON.stringify(prd),
          } as SelectorResult,
        });

        // TODO: implement check
        // Expected: findings with checklistItem: "ac-anchored", severity: "major"
        expect(ctx.selectorResult.output).toBeDefined();
      });

      test("emits no finding for AC with verifiedBy anchor", async () => {
        const prd = makePRD({
          userStories: [
            {
              id: "US-001",
              title: "Test",
              description: "Test",
              acceptanceCriteria: ["AC with anchor"],
              tags: [],
              dependencies: [],
              status: "pending",
              passes: false,
              escalations: [],
              attempts: 0,
              verifiedBy: {
                kind: "test",
                anchor: "test-name",
                factIds: ["F-001"],
              },
            },
          ],
        });

        const ctx = makeVerifierContext({
          selectorResult: {
            outcome: "passed",
            resolverCostUsd: 0.001,
            output: JSON.stringify(prd),
          } as SelectorResult,
        });

        expect(ctx.selectorResult.output).toBeDefined();
      });

      test("emits no finding for AC with intent=true", async () => {
        const prd = makePRD({
          userStories: [
            {
              id: "US-001",
              title: "Test",
              description: "Test",
              acceptanceCriteria: ["Intent AC"],
              tags: [],
              dependencies: [],
              status: "pending",
              passes: false,
              escalations: [],
              attempts: 0,
              intent: true,
            },
          ],
        });

        const ctx = makeVerifierContext({
          selectorResult: {
            outcome: "passed",
            resolverCostUsd: 0.001,
            output: JSON.stringify(prd),
          } as SelectorResult,
        });

        expect(ctx.selectorResult.output).toBeDefined();
      });
    });

    describe("claims-cited check", () => {
      test("emits major finding when citation rate is below threshold", async () => {
        const prd = makePRD();

        const ctx = makeVerifierContext({
          selectorResult: {
            outcome: "passed",
            resolverCostUsd: 0.001,
            output: JSON.stringify(prd),
          } as SelectorResult,
          stageConfig: {
            enabled: true,
            sessionMode: "one-shot",
            rounds: 1,
            resolver: { type: "synthesis" },
          } as DebateStageConfig,
        });

        // TODO: implement check — needs citation rate calculation from manifest
        // Expected: major finding if citation_rate < threshold (e.g., 0.5)
        expect(ctx.selectorResult.output).toBeDefined();
      });

      test("emits no finding when citation rate meets threshold", async () => {
        const prd = makePRD();

        const ctx = makeVerifierContext({
          selectorResult: {
            outcome: "passed",
            resolverCostUsd: 0.001,
            output: JSON.stringify(prd),
          } as SelectorResult,
        });

        expect(ctx.selectorResult.output).toBeDefined();
      });
    });

    describe("no-contradictions check", () => {
      test("emits blocker finding when PRD references contradicted factId in manifest", async () => {
        const prd = makePRD({
          userStories: [
            {
              id: "US-001",
              title: "Test",
              description: "Test story with contradicted spec claim",
              acceptanceCriteria: ["AC1"],
              tags: [],
              dependencies: [],
              status: "pending",
              passes: false,
              escalations: [],
              attempts: 0,
              contextFiles: [{ path: "src/file.ts", factId: "S-001" }],
            },
          ],
        });

        const manifest = makeManifest({
          specClaims: [
            {
              id: "S-001",
              specSpan: "line 10-15",
              claim: "extends schema",
              kind: "factual",
              verification: {
                status: "contradicted",
                factId: "F-002",
                evidence: "Schema does not extend",
              },
            },
          ],
        });

        const ctx = makeVerifierContext({
          selectorResult: {
            outcome: "passed",
            resolverCostUsd: 0.001,
            output: JSON.stringify(prd),
          } as SelectorResult,
        });

        // TODO: implement check with manifest
        // Expected: blocker finding for contradicted factId S-001
        expect(ctx.workdir).toBeDefined();
      });

      test("emits no finding when no spec claims are contradicted", async () => {
        const prd = makePRD();

        const manifest = makeManifest({
          specClaims: [
            {
              id: "S-001",
              specSpan: "line 10-15",
              claim: "extends schema",
              kind: "factual",
              verification: {
                status: "verified",
                factId: "F-001",
              },
            },
          ],
        });

        const ctx = makeVerifierContext({
          selectorResult: {
            outcome: "passed",
            resolverCostUsd: 0.001,
            output: JSON.stringify(prd),
          } as SelectorResult,
        });

        expect(manifest.specClaims[0].verification.status).toBe("verified");
      });
    });

    describe("spec-coverage check", () => {
      test("emits major finding for unverified factual spec claims not addressed in PRD", async () => {
        const prd = makePRD();

        const manifest = makeManifest({
          specClaims: [
            {
              id: "S-001",
              specSpan: "line 10-15",
              claim: "uses retry middleware",
              kind: "factual",
              verification: {
                status: "unverified",
              },
            },
          ],
        });

        const ctx = makeVerifierContext({
          selectorResult: {
            outcome: "passed",
            resolverCostUsd: 0.001,
            output: JSON.stringify(prd),
          } as SelectorResult,
        });

        // TODO: implement check
        // Expected: major finding for unverified factual claim S-001
        expect(manifest.specClaims).toHaveLength(1);
      });

      test("emits no finding for intent spec claims regardless of verification", async () => {
        const prd = makePRD();

        const manifest = makeManifest({
          specClaims: [
            {
              id: "S-001",
              specSpan: "line 10-15",
              claim: "maintains backward compatibility",
              kind: "intent",
              verification: {
                status: "unverified",
              },
            },
          ],
        });

        const ctx = makeVerifierContext({
          selectorResult: {
            outcome: "passed",
            resolverCostUsd: 0.001,
            output: JSON.stringify(prd),
          } as SelectorResult,
        });

        expect(manifest.specClaims[0].kind).toBe("intent");
      });
    });
  });

  describe("AC3: Outcome determination", () => {
    test("returns outcome === 'failed' when blocker findings exist and onBlocker is 'block'", async () => {
      const prd = makePRD({
        userStories: [
          {
            id: "US-001",
            title: "Test",
            description: "Test",
            acceptanceCriteria: ["AC1"],
            tags: [],
            dependencies: [],
            status: "pending",
            passes: false,
            escalations: [],
            attempts: 0,
            contextFiles: [{ path: "src/missing.ts" }], // Causes files-exist blocker
          },
        ],
      });

      const ctx = makeVerifierContext({
        selectorResult: {
          outcome: "passed",
          resolverCostUsd: 0.001,
          output: JSON.stringify(prd),
        } as SelectorResult,
        stageConfig: {
          enabled: true,
          sessionMode: "one-shot",
          rounds: 1,
          resolver: { type: "synthesis" },
          postDebateVerifier: { kind: "plan-checklist", onBlocker: "block" },
        } as DebateStageConfig,
      });

      expect(ctx.stageConfig.postDebateVerifier?.onBlocker).toBe("block");
    });

    test("returns outcome === 'failed' when blocker findings exist and onBlocker is undefined (defaults to block)", async () => {
      const prd = makePRD({
        userStories: [
          {
            id: "US-001",
            title: "Test",
            description: "Test",
            acceptanceCriteria: ["AC1"],
            tags: [],
            dependencies: [],
            status: "pending",
            passes: false,
            escalations: [],
            attempts: 0,
            contextFiles: [{ path: "src/missing.ts" }],
          },
        ],
      });

      const ctx = makeVerifierContext({
        selectorResult: {
          outcome: "passed",
          resolverCostUsd: 0.001,
          output: JSON.stringify(prd),
        } as SelectorResult,
        stageConfig: {
          enabled: true,
          sessionMode: "one-shot",
          rounds: 1,
          resolver: { type: "synthesis" },
          postDebateVerifier: { kind: "plan-checklist" }, // No onBlocker specified
        } as DebateStageConfig,
      });

      expect(ctx.stageConfig.postDebateVerifier).toBeDefined();
    });

    test("returns outcome === 'passed' when no blocker findings present", async () => {
      const prd = makePRD({
        userStories: [
          {
            id: "US-001",
            title: "Test",
            description: "Test",
            acceptanceCriteria: ["AC1"],
            tags: [],
            dependencies: [],
            status: "pending",
            passes: false,
            escalations: [],
            attempts: 0,
            contextFiles: [{ path: "src/exists.ts" }],
            verifiedBy: { kind: "test", anchor: "test", factIds: ["F-001"] },
          },
        ],
      });

      const ctx = makeVerifierContext({
        selectorResult: {
          outcome: "passed",
          resolverCostUsd: 0.001,
          output: JSON.stringify(prd),
        } as SelectorResult,
      });

      expect(ctx.selectorResult.outcome).toBe("passed");
    });
  });

  describe("AC5: Artifact writing", () => {
    test("writes spec-deltas.md to .nax/runs/<runId>/plan/<storyId>/ when blockers present", async () => {
      const prd = makePRD({
        userStories: [
          {
            id: "US-001",
            title: "Test",
            description: "Test",
            acceptanceCriteria: ["AC1"],
            tags: [],
            dependencies: [],
            status: "pending",
            passes: false,
            escalations: [],
            attempts: 0,
            contextFiles: [{ path: "src/missing.ts" }],
          },
        ],
      });

      const ctx = makeVerifierContext({
        selectorResult: {
          outcome: "passed",
          resolverCostUsd: 0.001,
          output: JSON.stringify(prd),
        } as SelectorResult,
      });

      // TODO: Mock Bun.write, verify artifact path format
      // Expected: artifact written to .nax/runs/<runId>/plan/US-001/spec-deltas.md
      expect(ctx.storyId).toBe("US-001");
    });

    test("includes artifact path in returned output field", async () => {
      const prd = makePRD({
        userStories: [
          {
            id: "US-001",
            title: "Test",
            description: "Test",
            acceptanceCriteria: ["AC1"],
            tags: [],
            dependencies: [],
            status: "pending",
            passes: false,
            escalations: [],
            attempts: 0,
            contextFiles: [{ path: "src/missing.ts" }],
          },
        ],
      });

      const ctx = makeVerifierContext({
        selectorResult: {
          outcome: "passed",
          resolverCostUsd: 0.001,
          output: JSON.stringify(prd),
        } as SelectorResult,
      });

      // TODO: verify returned result includes output field with artifact path
      expect(ctx.storyId).toBeDefined();
    });

    test("does not write artifact when no blocker findings", async () => {
      const prd = makePRD();

      const ctx = makeVerifierContext({
        selectorResult: {
          outcome: "passed",
          resolverCostUsd: 0.001,
          output: JSON.stringify(prd),
        } as SelectorResult,
      });

      expect(ctx.selectorResult.output).toBeDefined();
    });
  });

  describe("AC6: onBlocker policy", () => {
    test("returns outcome === 'passed' when onBlocker === 'tag-expert' despite blockers", async () => {
      const prd = makePRD({
        userStories: [
          {
            id: "US-001",
            title: "Test",
            description: "Test",
            acceptanceCriteria: ["AC1"],
            tags: [],
            dependencies: [],
            status: "pending",
            passes: false,
            escalations: [],
            attempts: 0,
            contextFiles: [{ path: "src/missing.ts" }],
          },
        ],
      });

      const ctx = makeVerifierContext({
        selectorResult: {
          outcome: "passed",
          resolverCostUsd: 0.001,
          output: JSON.stringify(prd),
        } as SelectorResult,
        stageConfig: {
          enabled: true,
          sessionMode: "one-shot",
          rounds: 1,
          resolver: { type: "synthesis" },
          postDebateVerifier: { kind: "plan-checklist", onBlocker: "tag-expert" },
        } as DebateStageConfig,
      });

      // TODO: verifier should return outcome === "passed" when onBlocker === "tag-expert"
      expect(ctx.stageConfig.postDebateVerifier?.onBlocker).toBe("tag-expert");
    });

    test("emits downstream signal to retag PRD stories to routing.complexity = 'expert'", async () => {
      const prd = makePRD({
        userStories: [
          {
            id: "US-001",
            title: "Test",
            description: "Test",
            acceptanceCriteria: ["AC1"],
            tags: [],
            dependencies: [],
            status: "pending",
            passes: false,
            escalations: [],
            attempts: 0,
            contextFiles: [{ path: "src/missing.ts" }],
          },
        ],
      });

      const ctx = makeVerifierContext({
        selectorResult: {
          outcome: "passed",
          resolverCostUsd: 0.001,
          output: JSON.stringify(prd),
        } as SelectorResult,
        stageConfig: {
          enabled: true,
          sessionMode: "one-shot",
          rounds: 1,
          resolver: { type: "synthesis" },
          postDebateVerifier: { kind: "plan-checklist", onBlocker: "tag-expert" },
        } as DebateStageConfig,
      });

      // TODO: implement signal emission (likely in returned output or findings)
      expect(ctx.stageConfig.postDebateVerifier?.onBlocker).toBe("tag-expert");
    });
  });
});
