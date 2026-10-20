import { describe, expect, test } from "bun:test";
import { type BotFixState, renderFixSummary } from "@/bot";
import { parseNaxBotMarker } from "@/forge";
import { safeCode } from "@/workflow/pr-body-safe";

const state: BotFixState = { step: "report", timings: {} };

describe("renderFixSummary", () => {
  test.each([
    ["pushed", "Pushed abcdef1: 3 agreed items fixed in one round; gates passed."],
    ["nothing", "Nothing to fix: the latest review agreed with no item."],
    ["no-change", "The fix session changed nothing; nothing pushed."],
    ["protected", "The fix changed protected files; nothing pushed."],
    ["no-gates", "No gates are configured on the base branch; nothing pushed."],
    ["gates-failed", "Gates failed: test, lint; nothing pushed."],
    ["push-rejected", "The push was rejected (the PR changed or access was denied); nothing pushed."],
  ] satisfies readonly (readonly [BotFixState["outcome"], string])[])("renders %s outcome", (outcome, expected) => {
    expect(
      renderFixSummary({ ...state, outcome, pushedSha: "abcdef12", agreedCount: 3, failingGates: ["test", "lint"] }),
    ).toContain(expected);
  });
  test("lists protected paths inside code spans", () => {
    expect(renderFixSummary({ ...state, outcome: "protected", protectedFiles: [".nax/config.json"] })).toContain(
      "- `.nax/config.json`",
    );
    expect(renderFixSummary({ ...state, outcome: "protected", protectedFiles: ["a`b\n.ts"] })).not.toContain(
      "a`b\n.ts",
    );
  });
  test.each([
    ".github/[click](http://evil.example/x).yml",
    ".github/@alice#12.yml",
    ".github/`[click](http://evil.example/x)`.yml",
  ])("keeps hostile protected path %s inside code spans", (path) => {
    const body = renderFixSummary({ ...state, outcome: "protected", protectedFiles: [path] });
    expect(body).toContain(`- \`${safeCode(path)}\``);
    expect(safeCode(path)).not.toContain("`");
  });
  test.each([
    "/repo/.nax-wt/[click](http://evil.example/x)",
    "/repo/.nax-wt/@alice#12",
    "/repo/.nax-wt/`[click](http://evil.example/x)`",
  ])("keeps hostile recovery path %s inside code spans", (path) => {
    const body = renderFixSummary({ ...state, outcome: "dirty", recoveryPath: path });
    expect(body).toContain(`\`${safeCode(path)}\``);
    expect(safeCode(path)).not.toContain("`");
  });
  test("includes fix failure", () => {
    expect(renderFixSummary({ ...state, outcome: "no-change", fixFailure: "boom" })).toContain("Fix session: boom");
  });
  test("neutralises and caps untrusted failure text", () => {
    const body = renderFixSummary({
      ...state,
      outcome: "no-change",
      fixFailure: `@alice #42 https://example.com ${"x".repeat(600)}`,
    });
    expect(body).not.toContain("@alice");
    expect(body).not.toContain("https://");
    expect(body).not.toContain("x".repeat(501));
  });
  test("marks the summary identity", () => {
    expect(parseNaxBotMarker(renderFixSummary({ ...state, outcome: "nothing" }))).toEqual({ key: "fix-summary" });
  });
});
