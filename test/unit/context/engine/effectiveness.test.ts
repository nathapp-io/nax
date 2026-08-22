/**
 * Amendment A AC-45: Effectiveness signal
 *
 * Unit tests for effectiveness.ts pure helpers:
 *   - classifyWithTerms + buildEvidenceTerms (per-chunk signal based on diff / output / findings)
 *
 * US-004: classifyEffectiveness wrapper removed — tests migrated to production helpers.
 */

import { describe, expect, test } from "bun:test";
import {
  _effectivenessDeps,
  annotateManifestEffectiveness,
  buildEvidenceTerms,
  // Barrel import — this is the production public API (used in AC1 tests)
  classifyWithTerms,
} from "@/context/engine";
import * as EngineBarrel from "@/context/engine";
// AC2: must import directly from effectiveness.ts to verify direct-vs-barrel equivalence
import { classifyWithTerms as classifyWithTermsDirect } from "@/context/engine/effectiveness";
import { _manifestStoreDeps } from "@/context/engine/manifest-store";
import { makeLogger, withDepsRestore } from "@test/helpers";

// ─────────────────────────────────────────────────────────────────────────────
// US-004: classifyWithTerms + buildEvidenceTerms (production helpers)
// ─────────────────────────────────────────────────────────────────────────────

describe("classifyWithTerms with buildEvidenceTerms", () => {
  // Helper to build the evidence once
  const makeEvidence = (agentOutput: string, diffText: string, findingMessages: string[]) =>
    buildEvidenceTerms(agentOutput, diffText, findingMessages);

  test("US-004 AC1: returns 'contradicted' when review finding shares >=3 significant terms", () => {
    const evidence = makeEvidence("", "", [
      "JWT authentication tokens should not be stored in cookies — use Bearer headers",
    ]);
    const result = classifyWithTerms(
      "Use JWT authentication tokens stored in secure cookies for session management",
      evidence,
    );
    expect(result.signal).toBe("contradicted");
  });

  test("US-004 AC1: returns 'followed' when diff shares sufficient coverage ratio with summary", () => {
    const evidence = makeEvidence(
      "argon2 password hashing authentication implementation complete",
      "-old hash\n+argon2 password hashing authentication",
      [],
    );
    const result = classifyWithTerms("Use argon2 for password hashing in authentication module", evidence);
    expect(result.signal).toBe("followed");
  });

  test("US-004 AC1: returns 'ignored' when chunk terms appear in neither diff nor output", () => {
    const evidence = makeEvidence(
      "Updated the database connection pool settings",
      "-old setting\n+new setting for connection pool",
      [],
    );
    const result = classifyWithTerms(
      "Cache invalidation should use distributed Redis cluster for session storage invalidation",
      evidence,
    );
    expect(result.signal).toBe("ignored");
  });

  test("US-004 AC1: returns 'unknown' when summary is too short for meaningful comparison", () => {
    const evidence = makeEvidence("ok", "+ok", ["ok"]);
    const result = classifyWithTerms("ok", evidence);
    expect(result.signal).toBe("unknown");
  });

  test("US-004 AC1: contradicted takes priority over followed", () => {
    const evidence = makeEvidence(
      "jwt authentication session management",
      "-old\n+jwt authentication session management",
      ["JWT authentication tokens are no longer valid for session management validation"],
    );
    const result = classifyWithTerms("Use JWT authentication tokens for session management validation", evidence);
    expect(result.signal).toBe("contradicted");
  });

  test("US-004 AC1: includes evidence string when signal is not unknown", () => {
    const evidence = makeEvidence("", "", [
      "JWT authentication tokens should not be stored in cookies — use Bearer headers",
    ]);
    const result = classifyWithTerms(
      "Use JWT authentication tokens stored in secure cookies for session management",
      evidence,
    );
    expect(result.evidence).toBeDefined();
    expect(typeof result.evidence).toBe("string");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-004 AC2: barrel import == direct import
// ─────────────────────────────────────────────────────────────────────────────

describe("US-004 AC2: classifyWithTerms barrel vs direct import", () => {
  test("barrel-exported classifyWithTerms returns identical signal as direct import", () => {
    const summary = "Use JWT authentication tokens for secure session management";
    const evidence = buildEvidenceTerms(
      "jwt authentication session management implemented",
      "+jwt auth token session",
      [],
    );

    // Direct import from effectiveness.ts
    const directResult = classifyWithTermsDirect(summary, evidence);

    // Barrel import via engine barrel
    const barrelResult = EngineBarrel.classifyWithTerms(summary, evidence);

    expect(barrelResult.signal).toBe(directResult.signal);
  });

  test("barrel-exported classifyWithTerms returns identical evidence as direct import", () => {
    const summary = "Use JWT authentication tokens stored in secure cookies for session management";
    const evidence = buildEvidenceTerms("", "", [
      "JWT authentication tokens should not be stored in cookies — use Bearer headers",
    ]);

    const directResult = classifyWithTermsDirect(summary, evidence);
    const barrelResult = EngineBarrel.classifyWithTerms(summary, evidence);

    expect(barrelResult.signal).toBe(directResult.signal);
    expect(barrelResult.evidence).toBe(directResult.evidence);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-004 AC3: no classifyEffectiveness export
// ─────────────────────────────────────────────────────────────────────────────

describe("US-004 AC3: classifyEffectiveness is not exported", () => {
  // Verify effectiveness.ts module no longer exports classifyEffectiveness
  test("classifyEffectiveness is not exported from effectiveness.ts", () => {
    const effectivenessModule = require("@/context/engine/effectiveness");
    expect("classifyEffectiveness" in effectivenessModule).toBe(false);
  });

  // Verify the engine barrel does not re-export classifyEffectiveness
  test("classifyEffectiveness is not in the engine barrel", () => {
    expect("classifyEffectiveness" in EngineBarrel).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #506 — annotateManifestEffectiveness logs warn on read-modify-write failure
// ─────────────────────────────────────────────────────────────────────────────

const VALID_MANIFEST = JSON.stringify({
  requestId: "r1",
  stage: "execution",
  totalBudgetTokens: 1000,
  usedTokens: 100,
  includedChunks: ["chunk-a"],
  excludedChunks: [],
  floorItems: [],
  digestTokens: 10,
  buildMs: 50,
  chunkSummaries: {
    "chunk-a": "Use JWT authentication for secure session management with tokens",
  },
});

describe("annotateManifestEffectiveness — #506 catch block logging", () => {
  // Save/restore ALL keys of both deps objects. The previous hand-rolled
  // version listed only readFile/listManifestFiles/fileExists, so the write
  // stub leaked out of this file and into every test that ran after it in
  // the same process.
  withDepsRestore(_manifestStoreDeps);
  withDepsRestore(_effectivenessDeps);

  test("calls logger.warn when manifest read-modify-write throws", async () => {
    const logger = makeLogger();
    _effectivenessDeps.getLogger = () => logger;

    let readCount = 0;
    _manifestStoreDeps.listManifestFiles = async () => ["context-manifest-execution.json"];
    _manifestStoreDeps.fileExists = async () => true;
    _manifestStoreDeps.readFile = async () => {
      readCount++;
      if (readCount === 1) return VALID_MANIFEST; // loadContextManifests pass
      throw new Error("disk full"); // read-modify-write fails
    };

    await annotateManifestEffectiveness("/repo", "feat", "US-001", {
      agentOutput: "jwt authentication session management tokens",
      diffText: "+jwt auth",
      findingMessages: [],
    });

    const warns = logger.calls.filter((c) => c.level === "warn");
    expect(warns.length).toBeGreaterThan(0);
    expect(warns[0]?.stage).toBe("context-v2");
    expect(typeof warns[0]?.data?.error).toBe("string");
  });

  test("continues processing remaining manifests when one read-modify-write fails", async () => {
    _effectivenessDeps.getLogger = () => makeLogger();

    const written: string[] = [];
    let readCount = 0;
    _manifestStoreDeps.listManifestFiles = async () => ["context-manifest-execution.json", "context-manifest-tdd.json"];
    _manifestStoreDeps.fileExists = async () => true;
    _manifestStoreDeps.readFile = async (path: string) => {
      readCount++;
      // First two reads: initial load for both manifests
      if (readCount <= 2) return VALID_MANIFEST;
      // Third read (execution rmw): throw
      if (path.includes("execution")) throw new Error("disk full");
      return VALID_MANIFEST; // tdd rmw succeeds
    };
    _manifestStoreDeps.writeJson = async (path: string) => {
      written.push(path);
    };

    await annotateManifestEffectiveness("/repo", "feat", "US-001", {
      agentOutput: "jwt authentication session management tokens",
      diffText: "+jwt auth",
      findingMessages: [],
    });

    // At least one manifest was still written (the non-failing one)
    expect(written.length).toBeGreaterThan(0);
  });

  test("tokenizes shared evidence once across all included chunks", async () => {
    const manifest = JSON.stringify({
      ...JSON.parse(VALID_MANIFEST),
      includedChunks: ["chunk-a", "chunk-b", "chunk-c"],
      chunkSummaries: {
        "chunk-a": "Authentication authorization validation configuration",
        "chunk-b": "Database transaction isolation consistency",
        "chunk-c": "Observability tracing metrics instrumentation",
      },
    });
    const originalTokenize = _effectivenessDeps.tokenize;
    let tokenizeCalls = 0;
    let readCount = 0;

    _effectivenessDeps.tokenize = (text) => {
      tokenizeCalls++;
      return originalTokenize(text);
    };
    _manifestStoreDeps.listManifestFiles = async () => ["context-manifest-execution.json"];
    _manifestStoreDeps.fileExists = async () => true;
    _manifestStoreDeps.readFile = async () => {
      readCount++;
      return manifest;
    };
    _manifestStoreDeps.writeJson = async () => {};

    await annotateManifestEffectiveness("/repo", "feat", "US-001", {
      agentOutput: "unrelated agent response content",
      diffText: "+unrelated source modification",
      findingMessages: ["unrelated review observation"],
    });

    expect(readCount).toBe(2);
    // Three chunk summaries plus one agent output, one whole-diff, one
    // added-lines, and one finding tokenization — each shared evidence term
    // set is still tokenized exactly once across all included chunks.
    expect(tokenizeCalls).toBe(7);
  });
});
