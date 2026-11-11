/**
 * US-010 (branch-review-coverage): a coverage item's opener lists the paths it covers, rendered
 * through `safeCode` so `@` and `#1` survive, and `parseItemFiles` reads them back from a raw or
 * forge-marked body. Item identity (first line, `parseItemOpener`, `itemKey`) is untouched.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type ForgeDeps, withNaxBotMarker } from "@/forge";
import { initLogger, resetLogger } from "@/logger";
import { describeUnread } from "@/workflow/approval";
import { newFeatureRecord } from "@/workflow/feature-record";
import { itemKey, parseItemFiles, parseItemOpener, renderItemOpener } from "@/workflow/item-threads";
import { postItemThreads } from "@/workflow/item-threads-post";
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
    expect(at).toBeGreaterThan(-1);
    expect(lines.slice(at + 1, at + 3)).toEqual([" - `a.ts`", " - `b.ts`"]);
  });

  test("AC-4: the Files block comes before the reply instruction", () => {
    const lines = renderItemOpener(filesItem).split("\n");
    expect(lines.indexOf("Files:")).toBeGreaterThan(-1);
    expect(lines.indexOf("Files:")).toBeLessThan(lines.indexOf(REPLY_INSTRUCTION));
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

describe("postItemThreads publishes the files (US-010)", () => {
  const field = (cmd: string[] | undefined, name: string) =>
    cmd?.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);

  function harness() {
    const writes: string[][] = [];
    const ok = (value: unknown) => ({ exitCode: 0, stdout: JSON.stringify(value), stderr: "" });
    const deps: ForgeDeps = {
      readText: async () => null,
      run: async (cmd) => {
        // The index write has its own suite; these tests read the item openers.
        if (cmd.some((arg) => arg.includes("key=w-index"))) return ok({ id: 99 });
        if (cmd.includes("POST")) {
          writes.push(cmd);
          return ok({ id: 1 });
        }
        if (cmd[0] === "git") return { exitCode: 0, stdout: "git@github.com:o/r.git", stderr: "" };
        if (cmd.includes("user")) return ok({ login: "bot", username: "bot", id: 1 });
        if (cmd.includes("graphql")) {
          return ok({
            data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } } } },
          });
        }
        if (cmd.some((arg) => arg.includes("?per_page="))) return ok([]);
        return ok({ head: { sha: "head", ref: "feature" }, base: { ref: "main" }, user: { login: "author" } });
      },
    };
    return { deps, writes };
  }

  const record = (unread: readonly string[]) => ({
    ...newFeatureRecord({ now: "t", seed: "s", minors: [] }),
    reviewUnread: unread,
    reasons: [describeUnread(unread)],
  });

  beforeEach(() => {
    initLogger({ level: "warn", suppressConsole: true });
  });
  afterEach(() => {
    resetLogger();
  });

  test("AC-11: the posted opener reads back its unread files", async () => {
    const h = harness();
    const outcome = await postItemThreads(
      {
        record: record(["a.ts"]),
        url: "https://github.com/o/r/pull/7",
        projectDir: "/repo",
        feature: "demo",
        changedFiles: [".nax/features/demo/prd.json"],
      },
      h.deps,
    );
    expect(outcome).toEqual({ posted: 1, closed: 0, skipped: 0, failed: 0 });
    expect(h.writes).toHaveLength(1);
    expect(parseItemFiles(field(h.writes[0], "body") ?? "")).toEqual(["a.ts"]);
  });
});
