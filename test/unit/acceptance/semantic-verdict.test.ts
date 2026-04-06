/**
 * Unit tests for semantic verdict persistence (US-003)
 *
 * Covers:
 * - SemanticVerdict type shape (AC-1)
 * - persistSemanticVerdict writes to correct path (AC-2)
 * - persistSemanticVerdict creates semantic-verdicts dir when missing (AC-3)
 * - loadSemanticVerdicts returns empty array when dir is absent (AC-8)
 * - loadSemanticVerdicts parses all *.json files (AC-8)
 * - loadSemanticVerdicts skips invalid JSON and logs debug warning (AC-9)
 * - loadSemanticVerdicts ignores non-.json files (AC-8)
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import path from "node:path";
import {
  _semanticVerdictDeps,
  loadSemanticVerdicts,
  persistSemanticVerdict,
} from "../../../src/acceptance/semantic-verdict";
import type { SemanticVerdict } from "../../../src/acceptance/types";

// ---------------------------------------------------------------------------
// Save and restore _deps around each test
// ---------------------------------------------------------------------------

let savedDeps: typeof _semanticVerdictDeps;

beforeEach(() => {
  savedDeps = { ..._semanticVerdictDeps };
});

afterEach(() => {
  Object.assign(_semanticVerdictDeps, savedDeps);
});

// ---------------------------------------------------------------------------
// AC-1: SemanticVerdict type exported from src/acceptance/types.ts
// ---------------------------------------------------------------------------

describe("SemanticVerdict type", () => {
  test("can be constructed with all required fields", () => {
    const verdict: SemanticVerdict = {
      storyId: "US-001",
      passed: true,
      timestamp: "2026-01-01T00:00:00.000Z",
      acCount: 3,
      findings: [],
    };
    expect(verdict.storyId).toBe("US-001");
    expect(verdict.passed).toBe(true);
    expect(verdict.timestamp).toBe("2026-01-01T00:00:00.000Z");
    expect(verdict.acCount).toBe(3);
    expect(verdict.findings).toEqual([]);
  });

  test("findings field accepts ReviewFinding objects", () => {
    const verdict: SemanticVerdict = {
      storyId: "US-002",
      passed: false,
      timestamp: "2026-01-01T00:00:00.000Z",
      acCount: 2,
      findings: [
        {
          ruleId: "no-unused-vars",
          severity: "warning",
          file: "src/a.ts",
          line: 10,
          message: "unused variable",
        },
      ],
    };
    expect(verdict.findings).toHaveLength(1);
    expect(verdict.findings[0].ruleId).toBe("no-unused-vars");
    expect(verdict.findings[0].severity).toBe("warning");
  });

  test("passed field is boolean", () => {
    const passing: SemanticVerdict = {
      storyId: "US-003",
      passed: true,
      timestamp: "2026-01-01T00:00:00.000Z",
      acCount: 0,
      findings: [],
    };
    const failing: SemanticVerdict = { ...passing, passed: false };
    expect(typeof passing.passed).toBe("boolean");
    expect(typeof failing.passed).toBe("boolean");
  });
});

// ---------------------------------------------------------------------------
// AC-2: persistSemanticVerdict writes JSON to <featureDir>/semantic-verdicts/<storyId>.json
// ---------------------------------------------------------------------------

describe("persistSemanticVerdict — file path", () => {
  test("writes to featureDir/semantic-verdicts/<storyId>.json", async () => {
    const writtenPaths: string[] = [];
    _semanticVerdictDeps.writeFile = async (p) => {
      writtenPaths.push(p);
    };
    _semanticVerdictDeps.mkdirp = async () => {};

    const verdict: SemanticVerdict = {
      storyId: "US-001",
      passed: true,
      timestamp: "2026-01-01T00:00:00.000Z",
      acCount: 3,
      findings: [],
    };

    await persistSemanticVerdict("/feat/dir", "US-001", verdict);

    expect(writtenPaths).toHaveLength(1);
    expect(writtenPaths[0]).toBe(path.join("/feat/dir", "semantic-verdicts", "US-001.json"));
  });

  test("uses storyId as filename", async () => {
    const writtenPaths: string[] = [];
    _semanticVerdictDeps.writeFile = async (p) => {
      writtenPaths.push(p);
    };
    _semanticVerdictDeps.mkdirp = async () => {};

    const verdict: SemanticVerdict = {
      storyId: "US-042",
      passed: false,
      timestamp: "2026-01-01T00:00:00.000Z",
      acCount: 1,
      findings: [],
    };

    await persistSemanticVerdict("/feat/dir", "US-042", verdict);

    expect(writtenPaths[0]).toContain("US-042.json");
  });

  test("written JSON parses back to a matching SemanticVerdict", async () => {
    let writtenContent = "";
    _semanticVerdictDeps.writeFile = async (_p, c) => {
      writtenContent = c;
    };
    _semanticVerdictDeps.mkdirp = async () => {};

    const verdict: SemanticVerdict = {
      storyId: "US-001",
      passed: false,
      timestamp: "2026-04-05T10:00:00.000Z",
      acCount: 2,
      findings: [
        { ruleId: "r1", severity: "error", file: "src/a.ts", line: 5, message: "bad code" },
      ],
    };

    await persistSemanticVerdict("/feat/dir", "US-001", verdict);

    const parsed = JSON.parse(writtenContent) as SemanticVerdict;
    expect(parsed.storyId).toBe("US-001");
    expect(parsed.passed).toBe(false);
    expect(parsed.acCount).toBe(2);
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0].ruleId).toBe("r1");
    expect(typeof parsed.timestamp).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// AC-3: persistSemanticVerdict creates semantic-verdicts dir before writing
// ---------------------------------------------------------------------------

describe("persistSemanticVerdict — directory creation", () => {
  test("calls mkdirp with the semantic-verdicts subdirectory", async () => {
    const mkdirpCalls: string[] = [];
    _semanticVerdictDeps.mkdirp = async (dir) => {
      mkdirpCalls.push(dir);
    };
    _semanticVerdictDeps.writeFile = async () => {};

    const verdict: SemanticVerdict = {
      storyId: "US-001",
      passed: true,
      timestamp: "2026-01-01T00:00:00.000Z",
      acCount: 1,
      findings: [],
    };

    await persistSemanticVerdict("/feat/dir", "US-001", verdict);

    expect(mkdirpCalls).toHaveLength(1);
    expect(mkdirpCalls[0]).toBe(path.join("/feat/dir", "semantic-verdicts"));
  });

  test("calls mkdirp before writeFile", async () => {
    const callOrder: string[] = [];
    _semanticVerdictDeps.mkdirp = async () => {
      callOrder.push("mkdirp");
    };
    _semanticVerdictDeps.writeFile = async () => {
      callOrder.push("writeFile");
    };

    const verdict: SemanticVerdict = {
      storyId: "US-001",
      passed: true,
      timestamp: "2026-01-01T00:00:00.000Z",
      acCount: 0,
      findings: [],
    };

    await persistSemanticVerdict("/feat/dir", "US-001", verdict);

    expect(callOrder[0]).toBe("mkdirp");
    expect(callOrder[1]).toBe("writeFile");
  });
});

// ---------------------------------------------------------------------------
// AC-8: loadSemanticVerdicts — reads all *.json files, empty array when dir missing
// ---------------------------------------------------------------------------

describe("loadSemanticVerdicts — directory missing", () => {
  test("returns empty array when semantic-verdicts directory does not exist (ENOENT)", async () => {
    _semanticVerdictDeps.readdir = async () => {
      const err = Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
      throw err;
    };

    const result = await loadSemanticVerdicts("/feat/dir");

    expect(result).toEqual([]);
  });

  test("returns empty array when directory exists but is empty", async () => {
    _semanticVerdictDeps.readdir = async () => [];

    const result = await loadSemanticVerdicts("/feat/dir");

    expect(result).toEqual([]);
  });
});

describe("loadSemanticVerdicts — parses JSON files", () => {
  test("parses a single verdict file correctly", async () => {
    const verdict: SemanticVerdict = {
      storyId: "US-001",
      passed: true,
      timestamp: "2026-01-01T00:00:00.000Z",
      acCount: 2,
      findings: [],
    };
    _semanticVerdictDeps.readdir = async () => ["US-001.json"];
    _semanticVerdictDeps.readFile = async () => JSON.stringify(verdict);

    const result = await loadSemanticVerdicts("/feat/dir");

    expect(result).toHaveLength(1);
    expect(result[0].storyId).toBe("US-001");
    expect(result[0].passed).toBe(true);
    expect(result[0].acCount).toBe(2);
  });

  test("parses multiple verdict files and returns all", async () => {
    const v1: SemanticVerdict = {
      storyId: "US-001",
      passed: true,
      timestamp: "2026-01-01T00:00:00.000Z",
      acCount: 2,
      findings: [],
    };
    const v2: SemanticVerdict = {
      storyId: "US-002",
      passed: false,
      timestamp: "2026-01-01T00:00:00.000Z",
      acCount: 1,
      findings: [{ ruleId: "r1", severity: "error", file: "src/b.ts", line: 3, message: "oops" }],
    };
    _semanticVerdictDeps.readdir = async () => ["US-001.json", "US-002.json"];
    _semanticVerdictDeps.readFile = async (p) => {
      if (p.includes("US-001")) return JSON.stringify(v1);
      return JSON.stringify(v2);
    };

    const result = await loadSemanticVerdicts("/feat/dir");

    expect(result).toHaveLength(2);
    expect(result.find((v) => v.storyId === "US-001")?.passed).toBe(true);
    expect(result.find((v) => v.storyId === "US-002")?.passed).toBe(false);
    expect(result.find((v) => v.storyId === "US-002")?.findings).toHaveLength(1);
  });

  test("reads files from the semantic-verdicts subdirectory", async () => {
    const readPaths: string[] = [];
    const verdict: SemanticVerdict = {
      storyId: "US-001",
      passed: true,
      timestamp: "2026-01-01T00:00:00.000Z",
      acCount: 1,
      findings: [],
    };
    _semanticVerdictDeps.readdir = async () => ["US-001.json"];
    _semanticVerdictDeps.readFile = async (p) => {
      readPaths.push(p);
      return JSON.stringify(verdict);
    };

    await loadSemanticVerdicts("/feat/dir");

    expect(readPaths[0]).toBe(path.join("/feat/dir", "semantic-verdicts", "US-001.json"));
  });

  test("ignores files without .json extension", async () => {
    const verdict: SemanticVerdict = {
      storyId: "US-001",
      passed: true,
      timestamp: "2026-01-01T00:00:00.000Z",
      acCount: 1,
      findings: [],
    };
    _semanticVerdictDeps.readdir = async () => ["US-001.json", "US-001.json.bak", "notes.txt"];
    _semanticVerdictDeps.readFile = async () => JSON.stringify(verdict);

    const result = await loadSemanticVerdicts("/feat/dir");

    expect(result).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// AC-9: loadSemanticVerdicts skips malformed JSON and logs debug warning
// ---------------------------------------------------------------------------

describe("loadSemanticVerdicts — skips invalid JSON", () => {
  test("skips file with invalid JSON content", async () => {
    const goodVerdict: SemanticVerdict = {
      storyId: "US-001",
      passed: true,
      timestamp: "2026-01-01T00:00:00.000Z",
      acCount: 1,
      findings: [],
    };
    _semanticVerdictDeps.readdir = async () => ["US-001.json", "bad.json"];
    _semanticVerdictDeps.readFile = async (p) => {
      if (p.includes("bad")) return "NOT_VALID_JSON{{{";
      return JSON.stringify(goodVerdict);
    };
    _semanticVerdictDeps.logDebug = () => {};

    const result = await loadSemanticVerdicts("/feat/dir");

    expect(result).toHaveLength(1);
    expect(result[0].storyId).toBe("US-001");
  });

  test("logs a debug warning for each skipped file", async () => {
    const loggedMessages: string[] = [];
    _semanticVerdictDeps.readdir = async () => ["bad1.json", "bad2.json"];
    _semanticVerdictDeps.readFile = async () => "INVALID{{{";
    _semanticVerdictDeps.logDebug = (msg) => {
      loggedMessages.push(msg);
    };

    await loadSemanticVerdicts("/feat/dir");

    expect(loggedMessages.length).toBeGreaterThanOrEqual(2);
  });

  test("returns partial results when some files are valid and some are not", async () => {
    const valid: SemanticVerdict = {
      storyId: "US-001",
      passed: true,
      timestamp: "2026-01-01T00:00:00.000Z",
      acCount: 3,
      findings: [],
    };
    _semanticVerdictDeps.readdir = async () => ["US-001.json", "broken.json", "empty.json"];
    _semanticVerdictDeps.readFile = async (p) => {
      if (p.includes("US-001")) return JSON.stringify(valid);
      if (p.includes("broken")) return "{broken json";
      return "";
    };
    _semanticVerdictDeps.logDebug = () => {};

    const result = await loadSemanticVerdicts("/feat/dir");

    expect(result).toHaveLength(1);
  });
});
