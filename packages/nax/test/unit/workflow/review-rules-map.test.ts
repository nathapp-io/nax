/**
 * US-006 — `appendChangedFileRules`, the per-file rule map behind a review
 * package's "## Rules for the changed files" section.
 *
 * The section's own rendering is covered by
 * `test/unit/prompts/builders/rules-index-builder-changed-files.test.ts`; the two
 * review steps that call this function are covered by
 * `test/integration/workflow-review-rules.test.ts`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import type { ResolvedRule } from "@/context/rules/rule-set";
import {
  _reviewRulesMapDeps,
  type AppendChangedFileRulesInput,
  appendChangedFileRules,
} from "@/workflow/review-rules-map";

const original = { ..._reviewRulesMapDeps };
const dirs: string[] = [];

afterEach(async () => {
  Object.assign(_reviewRulesMapDeps, original);
  await Promise.all(dirs.map(cleanupTempDir));
  dirs.length = 0;
});

/** A `ResolvedRule` with only the fields the map reads. */
function resolvedRule(ruleId: string, extra: Partial<ResolvedRule> = {}): ResolvedRule {
  return {
    fileName: `${ruleId}.md`,
    content: "RULE-BODY\n",
    source: "repo",
    displayPath: `.nax/rules/${ruleId}.md`,
    ruleId,
    ...extra,
  };
}

/** One recorded `rulesForFile` call. */
interface Call {
  readonly path: string;
  readonly repoRoot: string;
  readonly overrideDir?: string;
  readonly overrideMode?: string;
}

/** Stub the resolver: `answer` maps a changed path to the rules governing it. */
function stubRules(answer: (path: string) => ResolvedRule[]): Call[] {
  const calls: Call[] = [];
  _reviewRulesMapDeps.rulesForFile = async (input) => {
    calls.push(input as Call);
    return answer(input.path);
  };
  return calls;
}

/** A package file with prior content, as `writeReviewPackage` leaves one. */
async function packageWith(content: string): Promise<string> {
  const dir = makeTempDir("wf-rules-map-");
  dirs.push(dir);
  const path = join(dir, "package-0.diff");
  await Bun.write(path, content);
  return path;
}

const INPUT: AppendChangedFileRulesInput = { repoRoot: "/repo", overrideMode: "merge" };

describe("appendChangedFileRules", () => {
  test("AC-4: the prior content stays a byte-identical prefix of the appended package", async () => {
    const prior = "## Commits (base0..HEAD)\nabc1234 feat: one\n\n## Diff\n+one\n";
    const path = await packageWith(prior);
    stubRules(() => [resolvedRule("a")]);

    await appendChangedFileRules(path, ["src/a.ts"], INPUT);

    const text = await Bun.file(path).text();
    expect(text.startsWith(prior)).toBe(true);
    expect(text.slice(prior.length)).toStartWith("\n## Rules for the changed files\n");
    expect(text).toContain("- `a` (.nax/rules/a.md): 1 changed files, e.g. src/a.ts");
  });

  test("AC-4: each governing rule gets one line, with at most three example paths in diff order", async () => {
    const path = await packageWith("## Diff\n");
    stubRules((changed) => (changed.startsWith("src/") ? [resolvedRule("a")] : [resolvedRule("b")]));

    await appendChangedFileRules(path, ["src/1.ts", "src/2.ts", "src/3.ts", "src/4.ts", "docs/x.md"], INPUT);

    const text = await Bun.file(path).text();
    expect(text).toContain("- `a` (.nax/rules/a.md): 4 changed files, e.g. src/1.ts, src/2.ts, src/3.ts");
    expect(text).toContain("- `b` (.nax/rules/b.md): 1 changed files, e.g. docs/x.md");
    expect(text).not.toContain("src/4.ts");
  });

  test("AC-4: a rule that governs no changed file gets no line", async () => {
    const path = await packageWith("## Diff\n");
    stubRules((changed) => (changed === "src/a.ts" ? [resolvedRule("a")] : []));

    await appendChangedFileRules(path, ["src/a.ts", "docs/x.md"], INPUT);

    const lines = (await Bun.file(path).text()).split("\n").filter((line) => line.startsWith("- "));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("`a`");
  });

  test("AC-5: no governing rule leaves the package byte-identical", async () => {
    const prior = "## Commits (base0..HEAD)\n(none)\n\n## Diff\n\n";
    const path = await packageWith(prior);
    stubRules(() => []);

    await appendChangedFileRules(path, ["src/a.ts", "docs/x.md"], INPUT);

    expect(await Bun.file(path).text()).toBe(prior);
  });

  test("AC-5: no governing rule creates no package when the file is absent", async () => {
    const dir = makeTempDir("wf-rules-map-");
    dirs.push(dir);
    const path = join(dir, "package-0.diff");
    stubRules(() => []);

    await appendChangedFileRules(path, ["src/a.ts"], INPUT);

    expect(await Bun.file(path).exists()).toBe(false);
  });

  test("AC-4: an existing blank line before the section is not doubled", async () => {
    const prior = "## Diff\n\n";
    const path = await packageWith(prior);
    stubRules(() => [resolvedRule("a")]);

    await appendChangedFileRules(path, ["src/a.ts"], INPUT);

    const text = await Bun.file(path).text();
    expect(text.startsWith(`${prior}## Rules for the changed files`)).toBe(true);
    expect(text).not.toContain("\n\n\n## Rules for the changed files");
  });

  test("AC-4: a missing package file is created with the section alone", async () => {
    const dir = makeTempDir("wf-rules-map-");
    dirs.push(dir);
    const path = join(dir, "package-0.diff");
    stubRules(() => [resolvedRule("a")]);

    await appendChangedFileRules(path, ["src/a.ts"], INPUT);

    expect(await Bun.file(path).text()).toStartWith("## Rules for the changed files\n");
  });

  test("AC-6: the resolver is called once per path not under a .nax/ directory, with that path and repoRoot", async () => {
    const path = await packageWith("## Diff\n");
    const calls = stubRules(() => [resolvedRule("a")]);

    await appendChangedFileRules(
      path,
      ["src/a.ts", ".nax", ".nax/features/f/prd.json", "packages/api/.nax/config.json", ".nax/config.json"],
      INPUT,
    );

    expect(calls).toEqual([{ path: "src/a.ts", repoRoot: "/repo", overrideMode: "merge" }]);
  });

  test("the override configuration reaches the resolver (AC-6)", async () => {
    const path = await packageWith("## Diff\n");
    const calls = stubRules(() => [resolvedRule("org", { source: "override", displayPath: "/abs/org-rules/org.md" })]);

    await appendChangedFileRules(path, ["src/a.ts"], {
      repoRoot: "/repo",
      overrideDir: "/abs/org-rules",
      overrideMode: "replace",
    });

    expect(calls).toEqual([
      { path: "src/a.ts", repoRoot: "/repo", overrideDir: "/abs/org-rules", overrideMode: "replace" },
    ]);
    expect(await Bun.file(path).text()).toContain("(/abs/org-rules/org.md)");
  });

  test("no changed paths writes nothing", async () => {
    const prior = "## Diff\n";
    const path = await packageWith(prior);
    const calls = stubRules(() => [resolvedRule("a")]);

    await appendChangedFileRules(path, [], INPUT);

    expect(calls).toEqual([]);
    expect(await Bun.file(path).text()).toBe(prior);
  });
});
