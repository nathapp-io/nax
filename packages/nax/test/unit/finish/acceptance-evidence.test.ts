import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { withTempDir } from "@test/helpers";
import { findingIdentifiers, findPinnedAcs, loadAcceptanceFiles, splitAcBlocks } from "@/finish";

const ts = [
  'import { emit } from "../src/session-event";',
  'test("AC-40: session_event carries the run envelope", () => {',
  "  expect(emit().envelope).toBeDefined();",
  "});",
  'test("AC-51: costSpentUsd is written per job", () => {',
  "  expect(row.costSpentUsd).toBe(1);",
  "});",
  'test("AC-52: unrelated", () => {});',
].join("\n");

const go = [
  "func TestAC40SessionEnvelope(t *testing.T) { // AC-40",
  "  if emit().Envelope == nil { t.Fatal() }",
  "}",
].join("\n");

describe("splitAcBlocks", () => {
  test("a block runs from the first mention of an AC id to the next anchor", () => {
    const blocks = splitAcBlocks(ts);
    expect(blocks.map((b) => b.acId)).toEqual(["AC-40", "AC-51", "AC-52"]);
    expect(blocks[0]?.text).toContain("envelope");
    expect(blocks[0]?.text).not.toContain("costSpentUsd");
  });
  test("language-neutral: a Go file with the AC id in a comment still splits", () => {
    expect(splitAcBlocks(go).map((b) => b.acId)).toEqual(["AC-40"]);
  });
  test("a later mention of an already-seen AC id does not start a new block", () => {
    expect(splitAcBlocks("// AC-1 a\nx\n// see AC-1 again\n// AC-2 b").map((b) => b.acId)).toEqual(["AC-1", "AC-2"]);
  });
  test("no AC ids: no blocks (Review Focus 5)", () => {
    expect(splitAcBlocks('test("works", () => {});')).toEqual([]);
  });
});

describe("findingIdentifiers", () => {
  test("backticked tokens, code-style title words and the anchor base name", () => {
    const ids = findingIdentifiers({
      title: "Write-only costSpentUsd column on thread_job",
      problem: "`costSpentUsd` is never read; see `ThreadJob.save`",
      file: "src/db/thread-job.ts",
    });
    expect(ids).toEqual(expect.arrayContaining(["costSpentUsd", "thread_job", "ThreadJob.save", "thread-job"]));
    expect(ids).not.toContain("column");
  });
});

describe("findPinnedAcs", () => {
  const files = [{ path: "test/acceptance/feat.test.ts", text: ts }];
  test("#2468: the finding about costSpentUsd pins AC-51 only", () => {
    const pinned = findPinnedAcs(files, { title: "Remove write-only `costSpentUsd`", problem: "p", file: "src/x.ts" });
    expect(pinned.map((p) => p.acId)).toEqual(["AC-51"]);
    expect(pinned[0]?.path).toBe("test/acceptance/feat.test.ts");
  });
  test("ordered by score, capped at 5 blocks, excerpts capped at 40 lines", () => {
    const many = Array.from({ length: 8 }, (_, i) => `// AC-${i + 1} fooBar\n${"line\n".repeat(60)}`).join("");
    const pinned = findPinnedAcs([{ path: "a.ts", text: many }], {
      title: "fooBar breaks",
      problem: "",
      file: undefined,
    });
    expect(pinned).toHaveLength(5);
    expect(pinned[0]?.excerpt.split("\n").length).toBeLessThanOrEqual(40);
  });
  test("no identifiers or no AC ids: nothing", () => {
    expect(findPinnedAcs([{ path: "a.ts", text: "plain" }], { title: "fooBar", problem: "", file: undefined })).toEqual(
      [],
    );
  });
});

describe("loadAcceptanceFiles", () => {
  test("reads existing files; a missing one is skipped, never thrown", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "t.ts"), ts);
      const out = await loadAcceptanceFiles(dir, ["t.ts", "missing.ts"]);
      expect(out.map((f) => f.path)).toEqual(["t.ts"]);
    });
  });
});
