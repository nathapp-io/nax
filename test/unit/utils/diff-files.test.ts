import { describe, expect, test } from "bun:test";
import { extractDiffFiles } from "@/utils/diff-files";

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
