import { describe, expect, test } from "bun:test";
import { buildSelfVerificationSection } from "../../../../src/prompts/sections/self-verification";

describe("buildSelfVerificationSection", () => {
  test("renders commands when configured", () => {
    const section = buildSelfVerificationSection("implementer", {
      packageDir: "/repo/packages/api",
      language: "typescript",
      lintCommand: "bun run lint",
      typecheckCommand: "bun run typecheck",
    });
    expect(section).toContain("# Self-Verification Gate");
    expect(section).toContain("`bun run lint`");
    expect(section).toContain("`bun run typecheck`");
    expect(section).toContain("SELF_VERIFICATION:");
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
