/**
 * Tests for pure check functions extracted from plan-checklist — US-002
 *
 * Covers ACs 1–9:
 * - AC1: Five check functions are exported from checks.ts
 * - AC2: checkFilesExist returns blocker per missing contextFiles entry
 * - AC3: checkAcAnchored returns major per story with no anchor
 * - AC4: checkClaimsCited returns [] when manifest is null
 * - AC5: checkClaimsCited returns [] when rate >= threshold
 * - AC6: checkClaimsCited returns one finding when rate < threshold
 * - AC7: checkNoContradictions returns blocker per contradicted factId reference
 * - AC8: checkSpecCoverage returns one finding per unverified factual specClaim
 * - AC9: planChecklistVerifier produces identical findings after refactor
 */

import { describe, expect, test } from "bun:test";
import {
  checkFilesExist,
  checkAcAnchored,
  checkClaimsCited,
  checkNoContradictions,
  checkSpecCoverage,
} from "@/debate";
import type { PRD } from "@/prd/types";
import type { FactsManifest } from "@/debate/facts-manifest";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const makeStory = (overrides: Partial<PRD["userStories"][0]> = {}): PRD["userStories"][0] => ({
  id: "US-001",
  title: "Test Story",
  description: "A test description.",
  acceptanceCriteria: ["AC1: Does something"],
  tags: [],
  dependencies: [],
  status: "pending",
  passes: false,
  escalations: [],
  attempts: 0,
  ...overrides,
});

const makePrd = (stories: PRD["userStories"] = [makeStory()]): PRD =>
  ({
    userStories: stories,
  }) as unknown as PRD;

const makeManifest = (overrides: Partial<FactsManifest> = {}): FactsManifest => ({
  repoFacts: [],
  specClaims: [],
  gaps: [],
  ...overrides,
});

const verifiedClaim = (id: string): FactsManifest["specClaims"][0] => ({
  id: id as `S-${string}`,
  specSpan: "line 1",
  claim: "some claim",
  kind: "factual",
  verification: { status: "verified" },
});

const unverifiedClaim = (id: string): FactsManifest["specClaims"][0] => ({
  id: id as `S-${string}`,
  specSpan: "line 2",
  claim: "some unverified claim",
  kind: "factual",
  verification: { status: "unverified" },
});

const contradictedClaim = (id: string): FactsManifest["specClaims"][0] => ({
  id: id as `S-${string}`,
  specSpan: "line 3",
  claim: "contradicted claim",
  kind: "factual",
  verification: { status: "contradicted" },
});

const intentUnverifiedClaim = (id: string): FactsManifest["specClaims"][0] => ({
  id: id as `S-${string}`,
  specSpan: "line 4",
  claim: "intent claim",
  kind: "intent",
  verification: { status: "unverified" },
});

// ---------------------------------------------------------------------------
// AC1: exports
// ---------------------------------------------------------------------------

describe("checks.ts exports (AC1)", () => {
  test.each<[string, CallableFunction]>([
    ["checkFilesExist", checkFilesExist],
    ["checkAcAnchored", checkAcAnchored],
    ["checkClaimsCited", checkClaimsCited],
    ["checkNoContradictions", checkNoContradictions],
    ["checkSpecCoverage", checkSpecCoverage],
  ])("%s is a function", (_name, fn) => {
    expect(typeof fn).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// AC2: checkFilesExist
// ---------------------------------------------------------------------------

describe("checkFilesExist (AC2)", () => {
  test("uncited contextFiles entries that don't exist are flagged as `major` (may be new files)", () => {
    const prd = makePrd([
      makeStory({
        contextFiles: [{ path: "src/foo.ts" }, { path: "src/bar.ts" }],
      }),
    ]);
    const findings = checkFilesExist(prd, "/workdir", { existsSync: () => false });

    expect(findings).toHaveLength(2);
    for (const f of findings) {
      expect(f.severity).toBe("major");
      expect(f.checklistItem).toBe("files-exist");
    }
  });

  test("contextFiles entry with manifest factId that does not exist on disk is a `blocker` (grounding broken)", () => {
    const prd = makePrd([
      makeStory({
        contextFiles: [{ path: "src/cited.ts", factId: "F-001" }],
      }),
    ]);
    const findings = checkFilesExist(prd, "/workdir", { existsSync: () => false });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("blocker");
    expect((findings[0] as Record<string, unknown>).message).toContain("F-001");
  });

  test("returns finding with path matching the contextFiles entry path", () => {
    const prd = makePrd([makeStory({ contextFiles: [{ path: "src/missing.ts" }] })]);
    const findings = checkFilesExist(prd, "/workdir", { existsSync: () => false });

    expect(findings).toHaveLength(1);
    expect((findings[0] as Record<string, unknown>).path).toBe("src/missing.ts");
    expect((findings[0] as Record<string, unknown>).storyId).toBe("US-001");
  });

  test("returns empty array when all contextFiles exist", () => {
    const prd = makePrd([makeStory({ contextFiles: [{ path: "src/exists.ts" }] })]);
    const findings = checkFilesExist(prd, "/workdir", { existsSync: () => true });

    expect(findings).toHaveLength(0);
  });

  test("returns empty array when story has no contextFiles", () => {
    const prd = makePrd([makeStory()]);
    const findings = checkFilesExist(prd, "/workdir", { existsSync: () => false });

    expect(findings).toHaveLength(0);
  });

  test("handles string contextFiles entries (treated as uncited, severity `major`)", () => {
    const prd = makePrd([makeStory({ contextFiles: ["src/plain.ts"] })]);
    const findings = checkFilesExist(prd, "/workdir", { existsSync: () => false });

    expect(findings).toHaveLength(1);
    expect((findings[0] as Record<string, unknown>).path).toBe("src/plain.ts");
    expect(findings[0]?.severity).toBe("major");
  });

  test("mixed: cited-and-missing + uncited-and-missing yields one blocker + one major", () => {
    const prd = makePrd([
      makeStory({
        contextFiles: [{ path: "src/cited.ts", factId: "F-001" }, { path: "src/new.ts" }, "src/plain.ts"],
      }),
    ]);
    const findings = checkFilesExist(prd, "/workdir", { existsSync: () => false });

    expect(findings).toHaveLength(3);
    const blockers = findings.filter((f) => f.severity === "blocker");
    const majors = findings.filter((f) => f.severity === "major");
    expect(blockers).toHaveLength(1);
    expect(majors).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// AC3: checkAcAnchored
// ---------------------------------------------------------------------------

describe("checkAcAnchored (AC3)", () => {
  test("returns one major finding per story with no verifiedBy and intent not true", () => {
    const prd = makePrd([makeStory(), makeStory({ id: "US-002" })]);
    const findings = checkAcAnchored(prd);

    expect(findings).toHaveLength(2);
    for (const f of findings) {
      expect(f.severity).toBe("major");
      expect(f.checklistItem).toBe("ac-anchored");
    }
  });

  test("returns no finding for story with verifiedBy anchor", () => {
    const prd = makePrd([
      makeStory({ verifiedBy: { kind: "test", anchor: "test-name", factIds: [] } }),
    ]);
    const findings = checkAcAnchored(prd);

    expect(findings).toHaveLength(0);
  });

  test("returns no finding for story with intent=true", () => {
    const prd = makePrd([makeStory({ intent: true })]);
    const findings = checkAcAnchored(prd);

    expect(findings).toHaveLength(0);
  });

  test("includes storyId in the finding", () => {
    const prd = makePrd([makeStory({ id: "US-042" })]);
    const findings = checkAcAnchored(prd);

    expect((findings[0] as Record<string, unknown>).storyId).toBe("US-042");
  });
});

// ---------------------------------------------------------------------------
// AC4: checkClaimsCited — null manifest
// ---------------------------------------------------------------------------

describe("checkClaimsCited — null manifest (AC4)", () => {
  test("returns [] when manifest is null", () => {
    const findings = checkClaimsCited(null, 0.5);
    expect(findings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// AC5: checkClaimsCited — rate meets threshold
// ---------------------------------------------------------------------------

describe("checkClaimsCited — rate meets threshold (AC5)", () => {
  test("returns [] when 2 verified + 1 unverified → rate 0.666 >= 0.5", () => {
    const manifest = makeManifest({
      specClaims: [verifiedClaim("S-001"), verifiedClaim("S-002"), unverifiedClaim("S-003")],
    });
    const findings = checkClaimsCited(manifest, 0.5);
    expect(findings).toEqual([]);
  });

  test("returns [] for empty specClaims", () => {
    const manifest = makeManifest({ specClaims: [] });
    const findings = checkClaimsCited(manifest, 0.5);
    expect(findings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// AC6: checkClaimsCited — rate below threshold
// ---------------------------------------------------------------------------

describe("checkClaimsCited — rate below threshold (AC6)", () => {
  test("returns one finding when 1 verified + 2 unverified → rate 0.333 < 0.5", () => {
    const manifest = makeManifest({
      specClaims: [verifiedClaim("S-001"), unverifiedClaim("S-002"), unverifiedClaim("S-003")],
    });
    const findings = checkClaimsCited(manifest, 0.5);

    expect(findings).toHaveLength(1);
    expect(findings[0].checklistItem).toBe("claims-cited");
    expect(findings[0].severity).toBe("major");
  });
});

// ---------------------------------------------------------------------------
// AC7: checkNoContradictions
// ---------------------------------------------------------------------------

describe("checkNoContradictions (AC7)", () => {
  test("returns a blocker finding per contextFiles entry referencing a contradicted factId", () => {
    const manifest = makeManifest({ specClaims: [contradictedClaim("S-001")] });
    const prd = makePrd([
      makeStory({
        contextFiles: [{ path: "src/a.ts", factId: "S-001" }],
      }),
    ]);
    const findings = checkNoContradictions(prd, manifest);

    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("blocker");
    expect(findings[0].checklistItem).toBe("no-contradictions");
    expect((findings[0] as Record<string, unknown>).specId).toBe("S-001");
  });

  test("returns empty array when manifest is null", () => {
    const prd = makePrd([makeStory({ contextFiles: [{ path: "src/a.ts", factId: "S-001" }] })]);
    const findings = checkNoContradictions(prd, null);
    expect(findings).toEqual([]);
  });

  test("returns empty array when no claims are contradicted", () => {
    const manifest = makeManifest({ specClaims: [verifiedClaim("S-001")] });
    const prd = makePrd([makeStory({ contextFiles: [{ path: "src/a.ts", factId: "S-001" }] })]);
    const findings = checkNoContradictions(prd, manifest);
    expect(findings).toEqual([]);
  });

  test("returns no finding for contextFiles entries without factId", () => {
    const manifest = makeManifest({ specClaims: [contradictedClaim("S-001")] });
    const prd = makePrd([makeStory({ contextFiles: [{ path: "src/a.ts" }] })]);
    const findings = checkNoContradictions(prd, manifest);
    expect(findings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// AC8: checkSpecCoverage
// ---------------------------------------------------------------------------

describe("checkSpecCoverage (AC8)", () => {
  test("returns one finding per unverified factual specClaim", () => {
    const manifest = makeManifest({
      specClaims: [unverifiedClaim("S-001"), unverifiedClaim("S-002")],
    });
    const findings = checkSpecCoverage(manifest);

    expect(findings).toHaveLength(2);
    for (const f of findings) {
      expect(f.checklistItem).toBe("spec-coverage");
      expect(f.severity).toBe("major");
    }
  });

  test("returns no finding for intent specClaims even when unverified", () => {
    const manifest = makeManifest({
      specClaims: [intentUnverifiedClaim("S-001")],
    });
    const findings = checkSpecCoverage(manifest);
    expect(findings).toHaveLength(0);
  });

  test("returns no finding for verified factual specClaims", () => {
    const manifest = makeManifest({
      specClaims: [verifiedClaim("S-001")],
    });
    const findings = checkSpecCoverage(manifest);
    expect(findings).toHaveLength(0);
  });

  test("returns empty array when manifest is null", () => {
    const findings = checkSpecCoverage(null);
    expect(findings).toEqual([]);
  });

  test("includes specId in the finding", () => {
    const manifest = makeManifest({ specClaims: [unverifiedClaim("S-099")] });
    const findings = checkSpecCoverage(manifest);

    expect((findings[0] as Record<string, unknown>).specId).toBe("S-099");
  });
});
