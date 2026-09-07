import { describe, expect, test } from "bun:test";
import { buildSelfVerificationSection } from "@/prompts/sections/self-verification";
import { createRunCommandTool } from "@/tools";

describe("buildSelfVerificationSection", () => {
  test("renders the gate header and the marker block", () => {
    const section = buildSelfVerificationSection("implementer", {
      packageDir: "/repo/packages/api",
      language: "typescript",
      lintCommand: "bun run lint",
      typecheckCommand: "bun run typecheck",
    });
    expect(section).toContain("# Self-Verification Gate");
    expect(section).toContain("SELF_VERIFICATION:");
  });

  test("names both affordances: the declared key AND the shell string", () => {
    // One prompt, two transports. Native has RunCommand (a nax-hosted coding
    // tool wired only into the native turn loop) and cannot run a shell string;
    // ACP has a shell and is never given codingTools at all. Naming only one
    // strands the other — dropping the shell string stranded the DEFAULT
    // transport, which is ACP via resolveDefaultAgent -> "claude".
    const section = buildSelfVerificationSection("implementer", {
      packageDir: "/repo/packages/api",
      language: "typescript",
      lintCommand: "biome check .",
      typecheckCommand: "bun x tsc --noEmit",
    });
    expect(section).toContain('RunCommand {"command": "lint"}');
    expect(section).toContain('RunCommand {"command": "typecheck"}');
    expect(section).toContain("bun x tsc --noEmit");
    expect(section).toContain("biome check .");
  });

  test("the rendered key is a real RunCommand key for the same config", () => {
    // Pins the invariant the wording rests on: the label rendered as
    // {"command": "<label>"} must be a key RunCommand actually accepts.
    // Both sides read quality.commands.<label>, and this asserts they agree.
    const commands = { lint: "biome check .", typecheck: "bun x tsc --noEmit" };
    const section = buildSelfVerificationSection("implementer", {
      packageDir: "/repo/packages/api",
      language: "typescript",
      lintCommand: commands.lint,
      typecheckCommand: commands.typecheck,
    });
    const tool = createRunCommandTool(new Map(Object.entries(commands)));
    const accepted = tool.scope.allowedVerbs ?? [];
    for (const key of ["lint", "typecheck"]) {
      expect(section).toContain(`RunCommand {"command": "${key}"}`);
      expect(accepted).toContain(key);
    }
  });

  test("renders skip messaging for unconfigured commands", () => {
    const section = buildSelfVerificationSection("implementer", {
      packageDir: "/repo/packages/api",
      language: "typescript",
      lintCommand: undefined,
      typecheckCommand: undefined,
    });
    expect(section).toContain("lint: unconfigured");
    expect(section).toContain("typecheck: unconfigured");
  });

  test("preserves no-test contract language", () => {
    const section = buildSelfVerificationSection("no-test", {
      packageDir: "/repo",
      language: "typescript",
      lintCommand: "bun run lint",
      typecheckCommand: "bun run typecheck",
    });
    expect(section).toContain("Keep the no-test contract");
    expect(section).not.toContain("RED phase");
  });

  test("allows minimal package-local prerequisite fixes when needed for the story ACs", () => {
    const section = buildSelfVerificationSection("no-test", {
      packageDir: "/repo",
      language: "typescript",
      lintCommand: "bun run lint",
      typecheckCommand: "bun run typecheck",
    });
    expect(section).toContain("smallest package-local fix");
    expect(section).toContain("do not edit unrelated sibling files");
  });
});
