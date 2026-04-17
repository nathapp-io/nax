/**
 * Amendment A AC-45: Effectiveness signal
 *
 * Unit tests for effectiveness.ts pure helpers:
 *   - classifyEffectiveness (per-chunk signal based on diff / output / findings)
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  _effectivenessDeps,
  annotateManifestEffectiveness,
  classifyEffectiveness,
} from "../../../../src/context/engine/effectiveness";
import { _manifestStoreDeps } from "../../../../src/context/engine/manifest-store";

// ─────────────────────────────────────────────────────────────────────────────
// classifyEffectiveness
// ─────────────────────────────────────────────────────────────────────────────

describe("classifyEffectiveness", () => {
  test("returns 'contradicted' when review finding message shares >=3 significant terms with chunk", () => {
    const result = classifyEffectiveness(
      "Use JWT authentication tokens stored in secure cookies for session management",
      "",
      "",
      ["JWT authentication tokens should not be stored in cookies — use Bearer headers"],
    );
    expect(result.signal).toBe("contradicted");
  });

  test("returns 'followed' when diff shares >=3 significant terms with chunk", () => {
    const result = classifyEffectiveness(
      "Use argon2 for password hashing in authentication module",
      "argon2 password hashing authentication implementation complete",
      "-old hash\n+argon2 password hashing authentication",
      [],
    );
    expect(result.signal).toBe("followed");
  });

  test("returns 'ignored' when chunk terms appear in neither diff nor output", () => {
    const result = classifyEffectiveness(
      "Cache invalidation should use distributed Redis cluster for session storage invalidation",
      "Updated the database connection pool settings",
      "-old setting\n+new setting for connection pool",
      [],
    );
    expect(result.signal).toBe("ignored");
  });

  test("returns 'unknown' when all inputs are empty", () => {
    const result = classifyEffectiveness("Some context chunk content here", "", "", []);
    expect(result.signal).toBe("unknown");
  });

  test("contradicted takes priority over followed", () => {
    const result = classifyEffectiveness(
      "Use JWT authentication tokens for session management validation",
      "jwt authentication session management",
      "-old\n+jwt authentication session management",
      ["JWT authentication tokens are no longer valid for session management validation"],
    );
    expect(result.signal).toBe("contradicted");
  });

  test("returns 'unknown' when chunk summary is too short for meaningful comparison", () => {
    const result = classifyEffectiveness("ok", "ok", "+ok", ["ok"]);
    expect(result.signal).toBe("unknown");
  });

  test("includes evidence string when signal is not unknown", () => {
    const result = classifyEffectiveness(
      "Use JWT authentication tokens stored in secure cookies for session management",
      "",
      "",
      ["JWT authentication tokens should not be stored in cookies — use Bearer headers"],
    );
    expect(result.evidence).toBeDefined();
    expect(typeof result.evidence).toBe("string");
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
  let origReadFile: typeof _manifestStoreDeps.readFile;
  let origListManifestFiles: typeof _manifestStoreDeps.listManifestFiles;
  let origFileExists: typeof _manifestStoreDeps.fileExists;
  let origGetLogger: typeof _effectivenessDeps.getLogger;

  beforeEach(() => {
    origReadFile = _manifestStoreDeps.readFile;
    origListManifestFiles = _manifestStoreDeps.listManifestFiles;
    origFileExists = _manifestStoreDeps.fileExists;
    origGetLogger = _effectivenessDeps.getLogger;
  });

  afterEach(() => {
    _manifestStoreDeps.readFile = origReadFile;
    _manifestStoreDeps.listManifestFiles = origListManifestFiles;
    _manifestStoreDeps.fileExists = origFileExists;
    _effectivenessDeps.getLogger = origGetLogger;
  });

  test("calls logger.warn when manifest read-modify-write throws", async () => {
    const warnArgs: Array<[string, string, Record<string, unknown>]> = [];
    _effectivenessDeps.getLogger = () =>
      ({
        warn: (stage: string, msg: string, ctx: Record<string, unknown>) => warnArgs.push([stage, msg, ctx]),
      }) as unknown as ReturnType<typeof _effectivenessDeps.getLogger>;

    let readCount = 0;
    _manifestStoreDeps.listManifestFiles = async () => ["context-manifest-execution.json"];
    _manifestStoreDeps.fileExists = async () => true;
    _manifestStoreDeps.readFile = async () => {
      readCount++;
      if (readCount === 1) return VALID_MANIFEST; // loadContextManifests pass
      throw new Error("disk full");               // read-modify-write fails
    };

    await annotateManifestEffectiveness("/repo", "feat", "US-001", {
      agentOutput: "jwt authentication session management tokens",
      diffText: "+jwt auth",
      findingMessages: [],
    });

    expect(warnArgs.length).toBeGreaterThan(0);
    expect(warnArgs[0][0]).toBe("context-v2");
    expect(typeof warnArgs[0][2].error).toBe("string");
  });

  test("continues processing remaining manifests when one read-modify-write fails", async () => {
    _effectivenessDeps.getLogger = () =>
      ({ warn: () => {} }) as unknown as ReturnType<typeof _effectivenessDeps.getLogger>;

    const written: string[] = [];
    let readCount = 0;
    _manifestStoreDeps.listManifestFiles = async () => [
      "context-manifest-execution.json",
      "context-manifest-tdd.json",
    ];
    _manifestStoreDeps.fileExists = async () => true;
    _manifestStoreDeps.readFile = async (path: string) => {
      readCount++;
      // First two reads: initial load for both manifests
      if (readCount <= 2) return VALID_MANIFEST;
      // Third read (execution rmw): throw
      if (path.includes("execution")) throw new Error("disk full");
      return VALID_MANIFEST; // tdd rmw succeeds
    };
    _manifestStoreDeps.writeFile = async (path: string) => {
      written.push(path);
      return 0;
    };

    await annotateManifestEffectiveness("/repo", "feat", "US-001", {
      agentOutput: "jwt authentication session management tokens",
      diffText: "+jwt auth",
      findingMessages: [],
    });

    // At least one manifest was still written (the non-failing one)
    expect(written.length).toBeGreaterThan(0);
  });
});
