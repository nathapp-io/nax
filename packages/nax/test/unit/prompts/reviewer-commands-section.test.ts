import { describe, expect, test } from "bun:test";
import { reviewerCommandsSection } from "@/prompts";

describe("reviewerCommandsSection (nax#2500)", () => {
  test("is a fixed, non-overridable instructions section that says edits are reverted", () => {
    const s = reviewerCommandsSection();
    expect(s.id).toBe("reviewer-commands");
    expect(s.overridable).toBe(false);
    expect(s.content).toContain("check mode");
    expect(s.content).toContain("reverted");
    // US-006 (nax#2527): unchanged — the workflow story/branch prompts carry the gate results themselves.
    expect(s.content).toContain("you may run commands");
  });

  test("no configured commands: no project-commands block", () => {
    expect(reviewerCommandsSection([]).content).toBe(reviewerCommandsSection().content);
    expect(reviewerCommandsSection().content).not.toContain("Project commands");
  });
});

describe("reviewerCommandsSection with project commands (nax#2904)", () => {
  const s = reviewerCommandsSection([
    { name: "testScoped", steps: ["bunx jest {{files}} --forceExit --passWithNoTests"], dir: "apps/web" },
    { name: "lint", steps: ["biome check .", "knip"], dir: "." },
  ]);

  test("renders each command exactly, with the directory it runs from", () => {
    expect(s.content).toContain("### Project commands");
    expect(s.content).toContain(
      "- `testScoped` (run from `apps/web`): `bunx jest {{files}} --forceExit --passWithNoTests`",
    );
    expect(s.content).toContain("- `lint` (run from the repo root): `biome check .`, then `knip`");
  });

  test("offers the commands as known-good information, not as a rule", () => {
    expect(s.content).toContain("They are known to work here; use them or adapt them as you need.");
    expect(s.content.split("### Project commands")[1]).not.toContain("Do not");
  });

  test("explains {{files}} only when a command uses it", () => {
    expect(s.content).toContain("`{{files}}`");
    const noFiles = reviewerCommandsSection([{ name: "lint", steps: ["eslint ."], dir: "." }]);
    expect(noFiles.content).not.toContain("{{files}}");
  });

  test("explains {{package}} when a command uses it", () => {
    const withPkg = reviewerCommandsSection([
      { name: "testScoped", steps: ["bunx turbo test --filter={{package}}"], dir: "." },
    ]);
    expect(withPkg.content).toContain("`{{package}}`");
    expect(s.content).not.toContain("{{package}}");
  });

  test("a command containing a backtick stays one code span", () => {
    const tick = reviewerCommandsSection([{ name: "lint", steps: ["eslint `git ls-files`"], dir: "." }]);
    expect(tick.content).toContain("- `lint` (run from the repo root): `` eslint `git ls-files` ``");
  });
});
