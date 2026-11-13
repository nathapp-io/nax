import { afterEach, describe, expect, test } from "bun:test";
import { makeConfigSlice, makeNaxConfig, makeTestRuntime, opSelector } from "@test/helpers";
import { workflowConfigSelector } from "@/config";
import { botPrReviewOp, workflowBranchReviewOp, workflowReReviewOp, workflowStoryReviewOp } from "@/operations";
import { reviewerCommandLines } from "@/operations/reviewer-command-lines";

const root = { repoRoot: "/repo", relativeFromRoot: "" };
const pkg = { repoRoot: "/repo", relativeFromRoot: "apps/web" };

describe("reviewerCommandLines (nax#2904)", () => {
  test("lists configured commands in a fixed order, test from review.commands first", () => {
    const lines = reviewerCommandLines(
      {
        quality: {
          commands: { lint: "biome check .", test: "bun test", testScoped: "bun test {{files}}", typecheck: "tsc" },
        },
        review: { commands: { test: "bun run test" } },
      },
      root,
    );
    expect(lines).toEqual([
      { name: "testScoped", steps: ["bun test {{files}}"], dir: "." },
      { name: "test", steps: ["bun run test"], dir: "." },
      { name: "lint", steps: ["biome check ."], dir: "." },
      { name: "typecheck", steps: ["tsc"], dir: "." },
    ]);
  });

  test("omits commands that are not configured and returns [] when none are", () => {
    expect(reviewerCommandLines({ quality: { commands: { lint: "eslint ." } } }, root)).toEqual([
      { name: "lint", steps: ["eslint ."], dir: "." },
    ]);
    expect(reviewerCommandLines({}, root)).toEqual([]);
  });

  test("keeps every step of a list-valued command", () => {
    const [line] = reviewerCommandLines({ quality: { commands: { lint: ["biome check .", "knip"] } } }, root);
    expect(line?.steps).toEqual(["biome check .", "knip"]);
  });

  test("a command the package overlay declares runs from the package dir, a root command from the repo root", () => {
    const lines = reviewerCommandLines(
      { quality: { commands: { lint: "biome check .", testScoped: "bunx jest {{files}} --forceExit" } } },
      { ...pkg, overlay: { quality: makeConfigSlice("quality", { commands: { test: "bunx jest" } }) } },
    );
    // testScoped follows the test gate's provenance, as verify-scoped does.
    expect(lines).toEqual([
      { name: "testScoped", steps: ["bunx jest {{files}} --forceExit"], dir: "apps/web" },
      { name: "lint", steps: ["biome check ."], dir: "." },
    ]);
  });

  test("an overlay that sets only review.commands.test still moves test and testScoped to the package", () => {
    const lines = reviewerCommandLines(
      { quality: { commands: { testScoped: "bunx jest {{files}}" } }, review: { commands: { test: "bunx jest" } } },
      { ...pkg, overlay: { review: makeConfigSlice("review", { commands: { test: "bunx jest" } }) } },
    );
    expect(lines.map((line) => [line.name, line.dir])).toEqual([
      ["testScoped", "apps/web"],
      ["test", "apps/web"],
    ]);
  });

  test("ignores blank command strings", () => {
    expect(reviewerCommandLines({ quality: { commands: { lint: "  ", typecheck: [] } } }, root)).toEqual([]);
  });
});

describe("review ops show the configured commands (nax#2904)", () => {
  const runtimes: ReturnType<typeof makeTestRuntime>[] = [];
  afterEach(async () => {
    await Promise.allSettled(runtimes.map((r) => r.close()));
    runtimes.length = 0;
  });
  function ctx() {
    const config = makeNaxConfig({ quality: { commands: { testScoped: "bunx jest {{files}} --forceExit" } } });
    const runtime = makeTestRuntime({ config });
    runtimes.push(runtime);
    const packageView = runtime.packages.repo();
    return { packageView, config: packageView.select(opSelector(workflowConfigSelector)) };
  }
  const base = { prompt: "review", timeoutMs: 1000 };
  const expected = "- `testScoped` (run from the repo root): `bunx jest {{files}} --forceExit`";

  test("story review, re-review, branch review and bot review all render them", () => {
    const built = [
      workflowStoryReviewOp.build(base, ctx()),
      workflowReReviewOp.build({ ...base, openIds: [] }, ctx()),
      workflowBranchReviewOp.build(
        { ...base, repoRoot: "/repo", minorIds: [], requiredFiles: [], range: "a..b" },
        ctx(),
      ),
      botPrReviewOp.build({ ...base, threadIds: [], commentIds: [] }, ctx()),
    ];
    for (const b of built) expect(b.instructions?.content).toContain(expected);
  });
});
