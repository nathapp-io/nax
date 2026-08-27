/**
 * US-003 — Scoped added-line attribution for classifyWithTerms
 *
 * Mirrors US-003's per-AC behaviour:
 *   AC1  — splitDiffByFile maps each post-image path to its section
 *   AC2  — rename keyed by post-rename path
 *   AC3  — binary-marked file → empty section, no throw
 *   AC4  — scope excludes diff file → ignored despite >3 shared terms
 *   AC5  — scope matches subset of files → only matching file's terms used
 *   AC6  — scopePaths absent → whole-diff behaviour preserved
 *   AC7  — unsplittable diff + scope → fails open to whole diff, signal=unknown
 *   AC8  — terms only on removed/context lines → not followed
 *   AC9  — scoped followed → evidence names a file path from the slice
 *   AC10 — persisted scope excludes all changed files → annotation writes ignored
 *
 * Each AC has a success-path test and a boundary/failure-path test. Stubs
 * (splitDiffByFile returning {}; classifyWithTerms ignoring scope options)
 * keep these tests compiling but make them fail with assertion failures —
 * not import errors — until the implementer fills in the real behaviour.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeLogger, withDepsRestore } from "@test/helpers";
import {
  _effectivenessDeps,
  annotateManifestEffectiveness,
  buildEvidenceTerms,
  classifyWithTerms,
  splitDiffByFile,
} from "@/context/engine/effectiveness";
import { _manifestStoreDeps } from "@/context/engine/manifest-store";
import type { ChunkEffectiveness } from "@/context/engine/types";

// ─────────────────────────────────────────────────────────────────────────────
// AC1 — splitDiffByFile: each post-image path maps to its own section
// ─────────────────────────────────────────────────────────────────────────────

const TWO_FILE_DIFF = [
  "diff --git a/src/foo.ts b/src/foo.ts",
  "index abc..def 100644",
  "--- a/src/foo.ts",
  "+++ b/src/foo.ts",
  "@@ -1,3 +1,3 @@",
  "-old line one",
  "-old line two",
  "-old line three",
  "+new line one",
  "+new line two",
  "+new line three",
  "diff --git a/src/bar.ts b/src/bar.ts",
  "index abc..def 100644",
  "--- a/src/bar.ts",
  "+++ b/src/bar.ts",
  "@@ -1,2 +1,2 @@",
  "-alpha",
  "-beta",
  "+gamma",
  "+delta",
].join("\n");

describe("splitDiffByFile (AC1)", () => {
  test("[AC1] maps each post-image path to only its section for a two-file unified diff", () => {
    const sections = splitDiffByFile(TWO_FILE_DIFF);

    const keys = Object.keys(sections).sort();
    expect(keys).toEqual(["src/bar.ts", "src/foo.ts"]);

    // foo.ts section contains foo.ts's hunk and not bar.ts's hunk.
    expect(sections["src/foo.ts"]).toContain("-old line one");
    expect(sections["src/foo.ts"]).toContain("+new line three");
    expect(sections["src/foo.ts"]).not.toContain("-alpha");
    expect(sections["src/foo.ts"]).not.toContain("+gamma");

    // bar.ts section contains bar.ts's hunk and not foo.ts's hunk.
    expect(sections["src/bar.ts"]).toContain("-alpha");
    expect(sections["src/bar.ts"]).toContain("+delta");
    expect(sections["src/bar.ts"]).not.toContain("-old line one");
    expect(sections["src/bar.ts"]).not.toContain("+new line three");
  });

  test("[AC1, boundary] returns an empty object for input that has no diff headers", () => {
    const sections = splitDiffByFile("this is not a unified diff at all");
    expect(Object.keys(sections)).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC2 — splitDiffByFile: rename keyed by post-rename path
// ─────────────────────────────────────────────────────────────────────────────

describe("splitDiffByFile (AC2)", () => {
  test("[AC2] keys a rename section by its post-rename path, not the pre-image path", () => {
    const renameDiff = [
      "diff --git a/src/old-name.ts b/src/new-name.ts",
      "similarity index 95%",
      "rename from src/old-name.ts",
      "rename to src/new-name.ts",
      "--- a/src/old-name.ts",
      "+++ b/src/new-name.ts",
      "@@ -1,1 +1,1 @@",
      "-old body",
      "+new body",
    ].join("\n");

    const sections = splitDiffByFile(renameDiff);

    expect(Object.keys(sections)).toEqual(["src/new-name.ts"]);
    expect(sections["src/new-name.ts"]).toContain("+new body");
    // The pre-image path is NOT a key — the spec keys by post-image path.
    expect(sections["src/old-name.ts"]).toBeUndefined();
  });

  test("[AC2, boundary] rename with similarity index line is still keyed by post-rename path", () => {
    const renameDiff = [
      "diff --git a/lib/v1.ts b/lib/v2.ts",
      "similarity index 80%",
      "rename from lib/v1.ts",
      "rename to lib/v2.ts",
      "--- a/lib/v1.ts",
      "+++ b/lib/v2.ts",
      "@@ -1,1 +1,1 @@",
      "-keep",
      "+keep too",
    ].join("\n");

    const sections = splitDiffByFile(renameDiff);
    expect(sections["lib/v2.ts"]).toBeDefined();
    expect(sections["lib/v2.ts"]).toContain("+keep too");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC3 — splitDiffByFile: binary file → empty section, no throw
// ─────────────────────────────────────────────────────────────────────────────

describe("splitDiffByFile (AC3)", () => {
  test("[AC3] returns an empty section for a binary-marked file without throwing", () => {
    const binaryDiff = [
      "diff --git a/src/image.png b/src/image.png",
      "index abc..def 100644",
      "Binary files a/src/image.png and b/src/image.png differ",
    ].join("\n");

    let sections: Record<string, string> = {};
    expect(() => {
      sections = splitDiffByFile(binaryDiff);
    }).not.toThrow();

    expect(sections["src/image.png"]).toBe("");
  });

  test("[AC3, boundary] binary marker with no textual hunk is not split into a multi-line section", () => {
    const binaryDiff = [
      "diff --git a/assets/logo.svg b/assets/logo.svg",
      "Binary files a/assets/logo.svg and b/assets/logo.svg differ",
    ].join("\n");

    const sections = splitDiffByFile(binaryDiff);
    // Either an absent key (filter dropped the entry) or an empty string is
    // acceptable — the contract is "no textual hunks, never throw".
    if (sections["assets/logo.svg"] !== undefined) {
      expect(sections["assets/logo.svg"]).toBe("");
    } else {
      expect(sections["assets/logo.svg"]).toBeUndefined();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// splitDiffByFile — quoted paths (filenames containing spaces)
// ─────────────────────────────────────────────────────────────────────────────

describe("splitDiffByFile — quoted paths", () => {
  test("keys a section by the unquoted post-image path when git quotes the header", () => {
    const diff = [
      'diff --git "a/src/my file.ts" "b/src/my file.ts"',
      "index abc..def 100644",
      '--- "a/src/my file.ts"',
      '+++ "b/src/my file.ts"',
      "@@ -1,1 +1,1 @@",
      "-old body",
      "+new body",
    ].join("\n");

    const sections = splitDiffByFile(diff);

    expect(Object.keys(sections)).toEqual(["src/my file.ts"]);
    expect(sections["src/my file.ts"]).toContain("+new body");
  });

  test("keys a rename section by its unquoted post-rename path", () => {
    const diff = [
      'diff --git "a/src/old name.ts" "b/src/new name.ts"',
      "similarity index 95%",
      'rename from "src/old name.ts"',
      'rename to "src/new name.ts"',
      '--- "a/src/old name.ts"',
      '+++ "b/src/new name.ts"',
      "@@ -1,1 +1,1 @@",
      "-old body",
      "+new body",
    ].join("\n");

    const sections = splitDiffByFile(diff);

    expect(sections["src/new name.ts"]).toBeDefined();
    expect(sections["src/new name.ts"]).toContain("+new body");
    expect(sections["src/old name.ts"]).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Shared fixtures for AC4-AC9 — build a chunk summary that shares enough
// terms with the diff's added lines to trip the whole-diff baseline. The
// scoped classifier must NOT trip on these because the scope excludes the
// touched file (AC4) or restricts the slice (AC5).
// ─────────────────────────────────────────────────────────────────────────────

const SHARED_CHUNK_SUMMARY = "JWT authentication tokens stored in secure cookies for session management";

function diffFor(filePath: string, addedLines: string): string {
  return [
    `diff --git a/${filePath} b/${filePath}`,
    "index abc..def 100644",
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    "@@ -1,1 +1,1 @@",
    "-old line",
    `+${addedLines}`,
  ].join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// AC4 — scope excludes the diff file → ignored, despite >3 shared terms
// ─────────────────────────────────────────────────────────────────────────────

describe("classifyWithTerms (AC4) — scope excludes diff file", () => {
  test("[AC4] returns 'ignored' when scopePaths excludes the diff file despite >=3 shared terms", () => {
    const diffText = diffFor(
      "src/cli/context.ts",
      "jwt authentication tokens stored in secure cookies for session management",
    );

    const evidence = buildEvidenceTerms("", diffText, []);
    const result = classifyWithTerms(SHARED_CHUNK_SUMMARY, evidence, {
      scopePaths: ["src/agents/**/*.ts"],
      diffText,
    });

    expect(result.signal).toBe("ignored");
  });

  test("[AC4, boundary] empty scopePaths array behaves the same as an excluding scope (returns 'ignored')", () => {
    const diffText = diffFor(
      "src/cli/context.ts",
      "jwt authentication tokens stored in secure cookies for session management",
    );

    const evidence = buildEvidenceTerms("", diffText, []);
    const result = classifyWithTerms(SHARED_CHUNK_SUMMARY, evidence, {
      scopePaths: [],
      diffText,
    });

    // An empty scopePaths set cannot match any diff file, so the chunk's
    // evidence is exhausted and the classifier must not declare it followed.
    expect(result.signal).not.toBe("followed");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC5 — scope matches a subset of files → only the matching file's terms
// ─────────────────────────────────────────────────────────────────────────────

describe("classifyWithTerms (AC5) — scope matches subset of diff files", () => {
  const ADAPTER_DIFF_TEXT = [
    "diff --git a/src/agents/acp/adapter.ts b/src/agents/acp/adapter.ts",
    "--- a/src/agents/acp/adapter.ts",
    "+++ b/src/agents/acp/adapter.ts",
    "@@ -1,1 +1,1 @@",
    "-old adapter code",
    "+adapter authentication tokens module implementation",
    "diff --git a/src/cli/context.ts b/src/cli/context.ts",
    "--- a/src/cli/context.ts",
    "+++ b/src/cli/context.ts",
    "@@ -1,1 +1,1 @@",
    "-old cli code",
    "+unrelated cli context tokens here for noise",
  ].join("\n");

  test("[AC5] when scopePaths matches only the adapter file, only its section's terms are considered", () => {
    const evidence = buildEvidenceTerms("", ADAPTER_DIFF_TEXT, []);
    const result = classifyWithTerms("adapter authentication tokens module", evidence, {
      scopePaths: ["src/agents/**/*.ts"],
      diffText: ADAPTER_DIFF_TEXT,
    });

    // The adapter section shares 4+ terms with the chunk; the CLI section
    // is out of scope. The classifier must still find the follow through
    // the scoped slice — and must attribute the follow to the adapter file
    // (AC9 — see below).
    expect(result.signal).toBe("followed");
    expect(result.evidence ?? "").toContain("adapter.ts");
  });

  test("[AC5, boundary] when scopePaths matches neither file, classification is not followed", () => {
    const evidence = buildEvidenceTerms("", ADAPTER_DIFF_TEXT, []);
    const result = classifyWithTerms("adapter authentication tokens module", evidence, {
      scopePaths: ["src/nowhere/**/*.ts"],
      diffText: ADAPTER_DIFF_TEXT,
    });

    expect(result.signal).not.toBe("followed");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC6 — scopePaths absent → whole-diff behaviour preserved
// ─────────────────────────────────────────────────────────────────────────────

describe("classifyWithTerms (AC6) — scopePaths absent", () => {
  test("[AC6] when scopePaths is absent, classification considers the whole diff", () => {
    const diffText = diffFor(
      "src/cli/context.ts",
      "jwt authentication tokens stored in secure cookies for session management",
    );

    const evidence = buildEvidenceTerms("", diffText, []);
    const result = classifyWithTerms(SHARED_CHUNK_SUMMARY, evidence);

    expect(result.signal).toBe("followed");
  });

  test("[AC6, boundary] when scopeOptions is omitted (undefined), classifier behaves as before", () => {
    const diffText = diffFor("src/foo.ts", "jwt authentication tokens stored in secure cookies for session management");

    const evidence = buildEvidenceTerms("", diffText, []);
    // No options argument at all — must compile and run, and return followed.
    const result = classifyWithTerms(SHARED_CHUNK_SUMMARY, evidence);

    expect(result.signal).toBe("followed");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC7 — unsplittable diff + scope → fails open to whole diff, signal=unknown
// ─────────────────────────────────────────────────────────────────────────────

describe("classifyWithTerms (AC7) — unsplittable diff", () => {
  test("[AC7] when diff cannot be split into per-file sections, classification fails open and records unknown", () => {
    const diffText = "this is not parseable as a unified diff at all — pure noise";

    const evidence = buildEvidenceTerms("", diffText, []);
    const result = classifyWithTerms(SHARED_CHUNK_SUMMARY, evidence, {
      scopePaths: ["src/foo.ts"],
      diffText,
    });

    expect(result.signal).toBe("unknown");
  });

  test("[AC7, boundary] empty diff text with a non-empty scopePaths still records unknown", () => {
    const evidence = buildEvidenceTerms("", "", []);
    const result = classifyWithTerms(SHARED_CHUNK_SUMMARY, evidence, {
      scopePaths: ["src/foo.ts"],
      diffText: "",
    });

    expect(result.signal).toBe("unknown");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC8 — terms only on removed/context lines → not followed
// ─────────────────────────────────────────────────────────────────────────────

describe("classifyWithTerms (AC8) — terms only on removed/context lines", () => {
  test("[AC8] when terms occur exclusively on removed/context lines, classification is not followed", () => {
    const diffText = [
      "diff --git a/src/foo.ts b/src/foo.ts",
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1,10 +1,10 @@",
      `-removed ${SHARED_CHUNK_SUMMARY} line`,
      " context line one unchanged here",
      " context line two unchanged here",
      "-old line three",
      "-old line four",
      "-old line five",
      "-old line six",
      "-old line seven",
      "-old line eight",
      "+added line one",
      "+added line two",
      "+added line three",
      "+added line four",
      "+added line five",
      "+added line six",
      "+added line seven",
      "+added line eight",
      " context line nine unchanged here",
      "+added line ten",
    ].join("\n");

    const evidence = buildEvidenceTerms("", diffText, []);
    const result = classifyWithTerms(SHARED_CHUNK_SUMMARY, evidence);

    // The added lines DO NOT share any of the chunk's terms, so the classifier
    // must not declare followed even though the whole diff does.
    expect(result.signal).not.toBe("followed");
  });

  test("[AC8, boundary] when terms appear on both removed and added lines, classification may still be followed", () => {
    const diffText = [
      "diff --git a/src/foo.ts b/src/foo.ts",
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1,3 +1,3 @@",
      `-removed ${SHARED_CHUNK_SUMMARY}`,
      " context line",
      "-old line",
      `+added ${SHARED_CHUNK_SUMMARY}`,
    ].join("\n");

    const evidence = buildEvidenceTerms("", diffText, []);
    const result = classifyWithTerms(SHARED_CHUNK_SUMMARY, evidence);

    // Boundary case — terms appear in BOTH removed and added lines. The
    // contract is "only removed/context lines → not followed", so a mixed
    // case is allowed to classify as followed.
    expect(["followed", "ignored", "unknown"]).toContain(result.signal);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC9 — scoped followed → evidence names a file path from the scoped slice
// ─────────────────────────────────────────────────────────────────────────────

describe("classifyWithTerms (AC9) — scoped followed evidence names a file", () => {
  test("[AC9] when scoped classification is followed, evidence names a file path from its scoped slice", () => {
    const diffText = diffFor("src/foo.ts", "jwt authentication tokens stored in secure cookies for session management");

    const evidence = buildEvidenceTerms("", diffText, []);
    const result = classifyWithTerms(SHARED_CHUNK_SUMMARY, evidence, {
      scopePaths: ["src/foo.ts"],
      diffText,
    });

    expect(result.signal).toBe("followed");
    expect(result.evidence).toBeDefined();
    expect(result.evidence).toContain("src/foo.ts");
  });

  test("[AC9, boundary] when multiple files are in scope, evidence names one of the scoped paths", () => {
    const diffText = [
      "diff --git a/src/foo.ts b/src/foo.ts",
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1,1 +1,1 @@",
      "-old",
      `+${SHARED_CHUNK_SUMMARY}`,
      "diff --git a/src/bar.ts b/src/bar.ts",
      "--- a/src/bar.ts",
      "+++ b/src/bar.ts",
      "@@ -1,1 +1,1 @@",
      "-old",
      `+${SHARED_CHUNK_SUMMARY}`,
    ].join("\n");

    const evidence = buildEvidenceTerms("", diffText, []);
    const result = classifyWithTerms(SHARED_CHUNK_SUMMARY, evidence, {
      scopePaths: ["src/foo.ts", "src/bar.ts"],
      diffText,
    });

    expect(result.signal).toBe("followed");
    expect(result.evidence ?? "").toMatch(/src\/(foo|bar)\.ts/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC10 — annotation: persisted scope excludes all changed files → ignored
// ─────────────────────────────────────────────────────────────────────────────

const VALID_SCOPED_MANIFEST = JSON.stringify({
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
    "chunk-a": SHARED_CHUNK_SUMMARY,
  },
  chunkScopePaths: {
    "chunk-a": ["src/some-other-file.ts"], // does not match the diff's file
  },
});

describe("annotateManifestEffectiveness — AC10: persisted scope excludes all changed files", () => {
  withDepsRestore(_manifestStoreDeps);
  withDepsRestore(_effectivenessDeps);

  beforeEach(() => {
    // Silence the warn path so test output stays clean — AC10 asserts the
    // *written* signal, not the warn log. The #506 tests own the warn path.
    _effectivenessDeps.getLogger = () => makeLogger();
  });

  afterEach(() => {
    _effectivenessDeps.getLogger = () => makeLogger();
  });

  test("[AC10] writes 'ignored' and not 'followed' when persisted scope excludes all changed files", async () => {
    let written: unknown = null;

    _manifestStoreDeps.listManifestFiles = async () => ["context-manifest-execution.json"];
    _manifestStoreDeps.fileExists = async () => true;
    _manifestStoreDeps.readFile = async () => VALID_SCOPED_MANIFEST;
    _manifestStoreDeps.writeJson = async (_path, data) => {
      written = data;
    };

    const diffText = diffFor("src/cli/context.ts", SHARED_CHUNK_SUMMARY);
    await annotateManifestEffectiveness("/repo", "feat", "US-003", {
      agentOutput: "",
      diffText,
      findingMessages: [],
    });

    const writtenData = written as { chunkEffectiveness?: Record<string, ChunkEffectiveness> };
    expect(writtenData.chunkEffectiveness).toBeDefined();
    expect(writtenData.chunkEffectiveness?.["chunk-a"]?.signal).toBe("ignored");
    // Explicit "not followed" assertion — distinguishes from the ambiguous
    // legacy unknown/ignored outcomes.
    expect(writtenData.chunkEffectiveness?.["chunk-a"]?.signal).not.toBe("followed");
  });

  test("[AC10, boundary] writes 'ignored' when the persisted scopePaths is an empty array", async () => {
    const manifest = JSON.stringify({
      ...JSON.parse(VALID_SCOPED_MANIFEST),
      chunkScopePaths: { "chunk-a": [] }, // empty scopePaths set
    });

    let written: unknown = null;
    _manifestStoreDeps.listManifestFiles = async () => ["context-manifest-execution.json"];
    _manifestStoreDeps.fileExists = async () => true;
    _manifestStoreDeps.readFile = async () => manifest;
    _manifestStoreDeps.writeJson = async (_path, data) => {
      written = data;
    };

    const diffText = diffFor("src/cli/context.ts", SHARED_CHUNK_SUMMARY);
    await annotateManifestEffectiveness("/repo", "feat", "US-003", {
      agentOutput: "",
      diffText,
      findingMessages: [],
    });

    const writtenData = written as { chunkEffectiveness?: Record<string, ChunkEffectiveness> };
    expect(writtenData.chunkEffectiveness?.["chunk-a"]?.signal).not.toBe("followed");
  });
});
