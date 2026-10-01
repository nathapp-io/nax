import { describe, expect, test } from "bun:test";
import { extractDiffFiles, extractDiffLineRanges } from "@/utils/diff-files";

describe("extractDiffFiles", () => {
  test("returns empty set for empty input", () => {
    expect(extractDiffFiles("")).toEqual(new Set());
  });

  test("extracts a single file path from one hunk", () => {
    const diff = `diff --git a/src/foo.ts b/src/foo.ts
index 1234..5678 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,4 @@
 line
+added
`;
    expect(extractDiffFiles(diff)).toEqual(new Set(["src/foo.ts"]));
  });

  test("extracts multiple files and dedupes across hunks", () => {
    const diff = `diff --git a/src/a.ts b/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
-x
+y
diff --git a/src/b.ts b/src/b.ts
+++ b/src/b.ts
@@ -1 +1 @@
-x
+y
diff --git a/src/a.ts b/src/a.ts
+++ b/src/a.ts
@@ -10 +10 @@
-x
+y
`;
    expect(extractDiffFiles(diff)).toEqual(new Set(["src/a.ts", "src/b.ts"]));
  });

  test("ignores +++ /dev/null (deletion-only side)", () => {
    const diff = `diff --git a/src/gone.ts b/src/gone.ts
deleted file mode 100644
--- a/src/gone.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-removed
`;
    expect(extractDiffFiles(diff)).toEqual(new Set());
  });

  test("handles CRLF line endings", () => {
    const diff = "+++ b/src/win.ts\r\n@@ -1 +1 @@\r\n-x\r\n+y\r\n";
    expect(extractDiffFiles(diff)).toEqual(new Set(["src/win.ts"]));
  });

  test("handles paths with spaces (git quotes them)", () => {
    const diff = `+++ b/src/has space.ts
@@ -1 +1 @@
-x
+y
`;
    expect(extractDiffFiles(diff)).toEqual(new Set(["src/has space.ts"]));
  });

  test("ignores spurious lines starting with +++", () => {
    const diff = `+++ b/src/real.ts
@@ -1 +1 @@
-x
++++ this is added content, not a header
`;
    expect(extractDiffFiles(diff)).toEqual(new Set(["src/real.ts"]));
  });
});

describe("extractDiffLineRanges", () => {
  test("AC1: returns a Map", () => {
    const result = extractDiffLineRanges("");
    expect(result).toBeInstanceOf(Map);
  });

  test("AC2: produces range from +++ b/ header and @@ -0,0 +1,5 @@", () => {
    const diff = `diff --git a/src/a.ts b/src/a.ts
new file mode 100644
index 0000..1234
--- /dev/null
+++ b/src/a.ts
@@ -0,0 +1,5 @@
+line1
+line2
+line3
+line4
+line5
`;
    const result = extractDiffLineRanges(diff);
    expect(result.get("src/a.ts")).toEqual([{ start: 1, end: 5 }]);
  });

  test("AC3: omitted counts default to 1 for @@ -1 +1 @@", () => {
    const diff = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
-x
+y
`;
    const result = extractDiffLineRanges(diff);
    expect(result.get("src/a.ts")).toEqual([{ start: 1, end: 1 }]);
  });

  test("AC4: hunk with new-side count 0 produces no range", () => {
    const diff = `diff --git a/src/gone.ts b/src/gone.ts
deleted file mode 100644
--- a/src/gone.ts
+++ /dev/null
@@ -5,3 +0,0 @@
-x
-y
-z
`;
    const result = extractDiffLineRanges(diff);
    expect(result.get("src/gone.ts")).toBeUndefined();
  });

  test("AC5: hunks for two files yield one entry per file", () => {
    const diff = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1,3 @@
-x
+y
+y
+y
diff --git a/src/b.ts b/src/b.ts
--- a/src/b.ts
+++ b/src/b.ts
@@ -10 +10,2 @@
-x
+y
+y
`;
    const result = extractDiffLineRanges(diff);
    expect(result.size).toBe(2);
    expect(result.get("src/a.ts")).toEqual([{ start: 1, end: 3 }]);
    expect(result.get("src/b.ts")).toEqual([{ start: 10, end: 11 }]);
  });

  test("AC6: +++ /dev/null produces no map entry", () => {
    const diff = `diff --git a/src/gone.ts b/src/gone.ts
deleted file mode 100644
--- a/src/gone.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-x
-y
-z
`;
    const result = extractDiffLineRanges(diff);
    expect(result.has("dev/null")).toBe(false);
    expect(result.size).toBe(0);
  });

  test("AC7: multiple hunks in same file are collected in order", () => {
    const diff = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,0 +11,2 @@
+a
+b
@@ -30,0 +40,1 @@
+c
`;
    const result = extractDiffLineRanges(diff);
    expect(result.get("src/a.ts")).toEqual([
      { start: 11, end: 12 },
      { start: 40, end: 40 },
    ]);
  });

  test("AC8: CRLF and LF diffs produce equal maps", () => {
    const lf = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1,2 @@
-x
+y
@@ -10 +10,2 @@
-x
+y
+y
`;
    const crlf = lf.replace(/\n/g, "\r\n");
    expect(extractDiffLineRanges(lf)).toEqual(extractDiffLineRanges(crlf));
  });

  test("AC9: empty input returns empty Map", () => {
    const result = extractDiffLineRanges("");
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
  });

  test("+++ /dev/null resets current file so subsequent hunks do not leak across", () => {
    const diff = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1,2 @@
-x
+y
diff --git a/src/gone.ts b/src/gone.ts
deleted file mode 100644
--- a/src/gone.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-x
-y
-z
diff --git a/src/b.ts b/src/b.ts
--- a/src/b.ts
+++ b/src/b.ts
@@ -10 +10,2 @@
-x
+y
+y
`;
    const result = extractDiffLineRanges(diff);
    expect(result.get("src/a.ts")).toEqual([{ start: 1, end: 2 }]);
    expect(result.has("src/gone.ts")).toBe(false);
    expect(result.get("src/b.ts")).toEqual([{ start: 10, end: 11 }]);
  });

  test("AC10: unrecognised lines are ignored without error", () => {
    const diff = `some preamble text that is not a diff header
this line means nothing
+++ b/src/a.ts
@@ -1 +1,2 @@
-x
+y
trailing garbage
@@ not a real hunk
`;
    const result = extractDiffLineRanges(diff);
    expect(result.get("src/a.ts")).toEqual([{ start: 1, end: 2 }]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// diff.noprefix — headers without the a/ b/ prefixes
// ─────────────────────────────────────────────────────────────────────────────

describe("diff parsing — diff.noprefix output", () => {
  const NOPREFIX_DIFF = [
    "diff --git src/a.ts src/a.ts",
    "index 111..222 100644",
    "--- src/a.ts",
    "+++ src/a.ts",
    "@@ -3,0 +4,2 @@",
    "+added one",
    "+added two",
  ].join("\n");

  test("extractDiffFiles reads an unprefixed +++ header", () => {
    // With `diff.noprefix=true` every header loses its `b/`. Recognising only
    // the prefixed form yielded an empty result, which the mutation spot-check
    // reads as "nothing changed" rather than "cannot parse".
    expect([...extractDiffFiles(NOPREFIX_DIFF)]).toEqual(["src/a.ts"]);
  });

  test("extractDiffLineRanges reads hunks under an unprefixed header", () => {
    expect(extractDiffLineRanges(NOPREFIX_DIFF).get("src/a.ts")).toEqual([{ start: 4, end: 5 }]);
  });

  test("an added line rendered as '+++ ...' is not mistaken for a header", () => {
    // An ADDED line whose content begins '++ ' renders as '+++ ...' inside a
    // hunk. Only a `+++` immediately following a `---` is a real header.
    const diff = [
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,0 +1,2 @@",
      "+++ this is content, not a header",
      "+normal added line",
    ].join("\n");

    expect([...extractDiffFiles(diff)]).toEqual(["src/a.ts"]);
    expect(extractDiffLineRanges(diff).get("src/a.ts")).toEqual([{ start: 1, end: 2 }]);
  });

  test("a '+++'-shaped content line does not orphan the following hunks", () => {
    const diff = [
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,0 +1,1 @@",
      "+++ content",
      "@@ -9,0 +12,3 @@",
      "+more",
    ].join("\n");

    expect(extractDiffLineRanges(diff).get("src/a.ts")).toEqual([
      { start: 1, end: 1 },
      { start: 12, end: 14 },
    ]);
  });

  test("an unprefixed /dev/null header names no file", () => {
    const diff = ["--- src/gone.ts", "+++ /dev/null", "@@ -1,2 +0,0 @@", "-a", "-b"].join("\n");
    expect([...extractDiffFiles(diff)]).toEqual([]);
    expect(extractDiffLineRanges(diff).size).toBe(0);
  });
});
