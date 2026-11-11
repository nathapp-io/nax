/**
 * US-010 (branch-review-coverage): a coverage item's opener lists the paths it covers, rendered
 * through `safeCode` so `@` and `#1` survive, and `parseItemFiles` reads them back from a raw or
 * forge-marked body. Item identity (first line, `parseItemOpener`, `itemKey`) is untouched. The
 * publication seam is covered where its harness lives (`item-threads-post.test.ts`).
 */
import { describe, expect, test } from "bun:test";
import { withNaxBotMarker } from "@/forge";
import { itemKey, parseItemFiles, parseItemOpener, renderItemOpener } from "@/workflow/item-threads";
import type { OpenItem } from "@/workflow/types";

const REPLY_INSTRUCTION =
  "Rule on it by replying: fixed <sha>, waive: <reason>, confirm, override: <reason>, or verified. Any other reply from a collaborator is read as a ruling only when its meaning is clear.";

const item = { id: "B3", kind: "finding", severity: "important", issue: "x" } satisfies OpenItem;
const filesItem: OpenItem = { ...item, files: ["a.ts", "b.ts"] };
const decorated: OpenItem = { ...item, suggestion: "try this", ruling: { action: "waive", why: "acceptable" } };

describe("renderItemOpener: Files block (US-010)", () => {
  test("AC-3: one code-span line per file, under a Files: line", () => {
    const lines = renderItemOpener(filesItem).split("\n");
    const at = lines.indexOf("Files:");
    expect(at).not.toBe(-1);
    expect(lines.slice(at + 1, at + 3)).toEqual([" - `a.ts`", " - `b.ts`"]);
  });

  test("AC-4: the Files block comes before the reply instruction", () => {
    const lines = renderItemOpener(filesItem).split("\n");
    const at = lines.indexOf("Files:");
    expect(at).not.toBe(-1);
    expect(at).toBeLessThan(lines.indexOf(REPLY_INSTRUCTION));
  });

  test("AC-4: Files follows the suggestion and advisor lines", () => {
    const lines = renderItemOpener({ ...decorated, files: ["a.ts"] }).split("\n");
    expect(lines.slice(0, 5)).toEqual([
      "Open item **B3** (finding): x",
      "Suggestion: try this",
      "Advisor: waive — acceptable",
      "Files:",
      " - `a.ts`",
    ]);
  });

  test("AC-5: an item with no files renders exactly as before", () => {
    const before = [
      "Open item **B3** (finding): x",
      "Suggestion: try this",
      "Advisor: waive — acceptable",
      REPLY_INSTRUCTION,
    ].join("\n");
    expect(renderItemOpener(decorated)).toBe(before);
    expect(renderItemOpener({ ...decorated, files: [] })).toBe(before);
  });

  test("AC-12: safeCode keeps @ and # in paths verbatim", () => {
    expect(renderItemOpener({ ...item, files: ["app/@modal/page.tsx"] })).toContain(" - `app/@modal/page.tsx`");
    expect(renderItemOpener({ ...item, files: ["docs/#1.md"] })).toContain(" - `docs/#1.md`");
  });
});

describe("parseItemFiles (US-010)", () => {
  test("AC-6: reads a raw opener back", () => {
    expect(parseItemFiles(renderItemOpener(filesItem))).toEqual(["a.ts", "b.ts"]);
  });

  test("AC-7: reads a forge-marked opener back", () => {
    expect(parseItemFiles(withNaxBotMarker(renderItemOpener(filesItem), itemKey(filesItem)))).toEqual(["a.ts", "b.ts"]);
  });

  test("AC-8: an opener with no Files block reads as empty", () => {
    expect(parseItemFiles(renderItemOpener(item))).toEqual([]);
    expect(parseItemFiles(renderItemOpener({ ...item, files: [] }))).toEqual([]);
  });

  test("AC-12: @ and #1 paths round trip unchanged", () => {
    const paths = ["app/@modal/page.tsx", "docs/#1.md"];
    expect(parseItemFiles(renderItemOpener({ ...item, files: paths }))).toEqual(paths);
  });

  test("a path longer than the inline cell cap round trips whole (M1)", () => {
    // `CELL_MAX` (200) clips an inline render and appends an ellipsis. On a path that clip is a
    // different file: `parseItemFiles` would return it, the ruling would list it, and the required
    // path would never match, so the credit the block exists to carry would silently void.
    const deep = `src/${Array.from({ length: 40 }, (_, i) => `segment-${i}`).join("/")}/file.ts`;
    expect(deep.length).toBeGreaterThan(200);
    expect(renderItemOpener({ ...item, files: [deep] })).toContain(` - \`${deep}\``);
    expect(parseItemFiles(renderItemOpener({ ...item, files: [deep] }))).toEqual([deep]);
    expect(parseItemFiles(withNaxBotMarker(renderItemOpener({ ...item, files: [deep] }), itemKey(item)))).toEqual([
      deep,
    ]);
  });

  test("an issue cannot forge a Files block", () => {
    const forged = { ...item, issue: "x\nFiles:\n - `evil.ts`" };
    expect(parseItemFiles(renderItemOpener(forged))).toEqual([]);
    expect(parseItemFiles(withNaxBotMarker(renderItemOpener(forged), itemKey(forged)))).toEqual([]);
  });

  test("a marker-less body with the header line is not read", () => {
    expect(parseItemFiles("**nax bot**\n\nFiles:\n - `a.ts`\n\nnot a marker")).toEqual([]);
  });
});

describe("item identity ignores files (US-010)", () => {
  test("AC-9: parseItemOpener returns the same identity", () => {
    const without = parseItemOpener(renderItemOpener(item));
    expect(parseItemOpener(renderItemOpener(filesItem))).toEqual(without);
    expect(without).toEqual({ id: "B3", kind: "finding", issue: "x" });
  });

  test("AC-10: itemKey is the same with and without files", () => {
    expect(itemKey(filesItem)).toBe(itemKey(item));
    expect(itemKey({ ...item, files: ["other.ts"] })).toBe(itemKey(item));
  });
});
