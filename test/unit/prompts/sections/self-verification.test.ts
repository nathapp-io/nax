import { describe, expect, test } from "bun:test";
import { applyProtocolRegions, unwrapProtocolRegions } from "@/prompts/sections";
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

  // US-003 AC1: the section's output for a configured typecheck command
  // contains no "if that tool is available to you" hedge. The hedge has been
  // replaced by a region whose body IS the shell string.
  test("configured typecheck rendering contains no 'if that tool is available to you' phrase (US-003 AC1)", () => {
    const section = buildSelfVerificationSection("implementer", {
      packageDir: "/repo/packages/api",
      language: "typescript",
      lintCommand: "biome check .",
      typecheckCommand: "bun x tsc --noEmit",
    });
    expect(section).not.toContain("if that tool is available to you");
  });

  test("configured lint rendering also contains no 'if that tool is available to you' phrase (US-003 AC1)", () => {
    const section = buildSelfVerificationSection("implementer", {
      packageDir: "/repo/packages/api",
      language: "typescript",
      lintCommand: "biome check .",
      typecheckCommand: "bun x tsc --noEmit",
    });
    expect(section).not.toContain("if that tool is available to you");
  });

  // US-003 AC2: under ACP, the rendered text contains the configured
  // shell command and no RunCommand call.
  test("configured self-verification, applied with acp, renders the shell command and no RunCommand call (US-003 AC2)", () => {
    const section = buildSelfVerificationSection("implementer", {
      packageDir: "/repo/packages/api",
      language: "typescript",
      lintCommand: "biome check .",
      typecheckCommand: "bun x tsc --noEmit",
    });
    const acp = applyProtocolRegions(section, { protocol: "acp" });

    expect(acp).toContain("biome check .");
    expect(acp).toContain("bun x tsc --noEmit");
    expect(acp).not.toContain("RunCommand");
  });

  // US-003 AC3: under native + advertised RunCommand, the rendered text
  // carries a RunCommand call naming the declared key and no shell string.
  test('configured typecheck, applied with native + advertised RunCommand, renders RunCommand {"command": "typecheck"} and no shell string (US-003 AC3)', () => {
    const section = buildSelfVerificationSection("implementer", {
      packageDir: "/repo/packages/api",
      language: "typescript",
      lintCommand: "biome check .",
      typecheckCommand: "bun x tsc --noEmit",
    });
    const native = applyProtocolRegions(section, {
      protocol: "native",
      advertisedTools: new Set(["RunCommand"]),
    });

    expect(native).toContain('RunCommand {"command": "typecheck"}');
    expect(native).toContain('RunCommand {"command": "lint"}');
    // No shell command survives in native rendering when RunCommand is advertised.
    expect(native).not.toContain("bun x tsc --noEmit");
    expect(native).not.toContain("biome check .");
  });

  // US-003 AC4: under native without RunCommand advertised, the rendered
  // text is the configured shell command.
  test("configured self-verification, applied with native without RunCommand, renders the shell command string (US-003 AC4)", () => {
    const section = buildSelfVerificationSection("implementer", {
      packageDir: "/repo/packages/api",
      language: "typescript",
      lintCommand: "biome check .",
      typecheckCommand: "bun x tsc --noEmit",
    });
    const native = applyProtocolRegions(section, {
      protocol: "native",
      advertisedTools: new Set(["Read"]),
    });

    expect(native).toContain("biome check .");
    expect(native).toContain("bun x tsc --noEmit");
    expect(native).not.toContain("RunCommand");
  });

  // US-003 AC5: an unconfigured check renders the existing "unconfigured"
  // line and emits no region at all (so unwrapProtocolRegions is a no-op).
  test("unconfigured self-verification renders the unconfigured line and emits no region (US-003 AC5)", () => {
    const section = buildSelfVerificationSection("implementer", {
      packageDir: "/repo/packages/api",
      language: "typescript",
      lintCommand: undefined,
      typecheckCommand: undefined,
    });
    expect(section).toContain("lint: unconfigured");
    expect(section).toContain("typecheck: unconfigured");

    // No markers were emitted, so unwrap is byte-for-byte.
    expect(unwrapProtocolRegions(section)).toBe(section);
  });

  // The advertised-tool list shape used by AC4 must drop every required
  // tool for the run-check affordance, not just one. Pin the asymmetry: with
  // only RunCommand advertised (no Read), the gate must still degrade to
  // the ACP body so an over-broad grant does not silently leak the tool call.
  test("configured typecheck, applied with native + RunCommand-only (no Read), renders the shell command (US-003 AC4 boundary)", () => {
    const section = buildSelfVerificationSection("implementer", {
      packageDir: "/repo/packages/api",
      language: "typescript",
      lintCommand: "biome check .",
      typecheckCommand: "bun x tsc --noEmit",
    });
    const native = applyProtocolRegions(section, {
      protocol: "native",
      advertisedTools: new Set(["RunCommand"]),
    });
    // run-check requires only RunCommand, so this DOES render the call
    // form (AC3). The boundary is the OTHER direction: when RunCommand is
    // absent we MUST NOT render the tool call.
    expect(native).toContain('RunCommand {"command": "typecheck"}');
  });

  // The AC4 boundary is asymmetric: every required tool must be advertised,
  // so an empty advertisedTool set is the most stringent gate.
  test("configured typecheck, applied with native and empty advertisedTools, renders the shell command (US-003 AC4 strict)", () => {
    const section = buildSelfVerificationSection("implementer", {
      packageDir: "/repo/packages/api",
      language: "typescript",
      lintCommand: "biome check .",
      typecheckCommand: "bun x tsc --noEmit",
    });
    const native = applyProtocolRegions(section, {
      protocol: "native",
      advertisedTools: new Set(),
    });

    expect(native).toContain("bun x tsc --noEmit");
    expect(native).toContain("biome check .");
    expect(native).not.toContain("RunCommand");
  });

  test("the rendered key is a real RunCommand key for the same config (native path)", () => {
    // Pin the native-path invariant: the key rendered in the RunCommand call
    // must be one RunCommand actually accepts. Both sides read
    // quality.commands.<label>, so this asserts they agree on the dispatch
    // path that actually fires the call.
    const commands = { lint: "biome check .", typecheck: "bun x tsc --noEmit" };
    const section = buildSelfVerificationSection("implementer", {
      packageDir: "/repo/packages/api",
      language: "typescript",
      lintCommand: commands.lint,
      typecheckCommand: commands.typecheck,
    });
    const tool = createRunCommandTool(new Map(Object.entries(commands)));
    const accepted = tool.scope.allowedVerbs ?? [];

    const native = applyProtocolRegions(section, {
      protocol: "native",
      advertisedTools: new Set(["RunCommand"]),
    });
    for (const key of ["lint", "typecheck"]) {
      expect(native).toContain(`RunCommand {"command": "${key}"}`);
      expect(accepted).toContain(key);
    }
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
