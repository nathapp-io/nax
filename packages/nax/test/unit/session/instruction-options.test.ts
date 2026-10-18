/**
 * US-007 — `instructionOptionsForSession` under `projectContext.mode: "replace"`.
 *
 * A native session discovers the repository's own instruction files itself. When
 * the run supplies a project-context file and asks for `replace`, that discovery
 * is stopped — not by turning instruction loading off, but by denying the *root*
 * file names, because package-level instruction files are explicitly still
 * loaded. `matchesDenyPaths` anchors each pattern on the whole repo-relative
 * path, so the bare names `rootInstructionDenyPaths` returns deny the root file
 * alone.
 *
 * `instruction-options.ts` is the only caller of `rootInstructionDenyPaths` in
 * production code, and this file is its unit test: the loader's own behaviour is
 * `test/unit/context/project-context-override.test.ts`.
 *
 * The AC id is the test-name prefix.
 */

import { describe, expect, test } from "bun:test";
import { makeNaxConfig } from "@test/helpers";
import type { AgentRunOptions } from "@/agents/types";
import type { NaxConfig } from "@/config";
import { instructionOptionsForSession } from "@/session/instruction-options";

/** The minimal run options the function reads; `config` is the only field under test. */
function options(config: NaxConfig, extra: Partial<AgentRunOptions> = {}): AgentRunOptions {
  return {
    prompt: "implement the story",
    workdir: "/repo",
    modelTier: "balanced",
    modelDef: { provider: "anthropic", model: "claude-sonnet-4-5" },
    timeoutSeconds: 60,
    config,
    ...extra,
  };
}

/** A run whose project-context override is configured, in `mode`. */
function replaceConfig(mode: "append" | "replace", extra: Record<string, unknown> = {}): NaxConfig {
  return makeNaxConfig({
    context: { projectContext: { file: "/abs/org-context.md", mode } },
    ...extra,
  });
}

const ROOT_DENIES = ["AGENTS.override.md", "AGENTS.md", "CLAUDE.md"];

describe("instructionOptionsForSession — replace mode (AC-12)", () => {
  test("AC-12: replace mode and a configured file append the root instruction denies after the configured ones", () => {
    const config = makeNaxConfig({
      context: { projectContext: { file: "/abs/org-context.md", mode: "replace" } },
      execution: { denyPaths: ["secret/**"] },
    });

    expect(instructionOptionsForSession("native", options(config))).toBeDefined();
    expect(instructionOptionsForSession("native", options(config)).instructionDenyPaths).toEqual([
      "secret/**",
      ...ROOT_DENIES,
    ]);
  });

  test("AC-12: the deny list is the configured one plus the root denies, with no duplicates from the config", () => {
    const config = makeNaxConfig({
      context: { projectContext: { file: "/abs/org-context.md", mode: "replace" } },
      execution: { denyPaths: ["secret/**", "vendor/**"] },
    });

    expect(instructionOptionsForSession("native", options(config)).instructionDenyPaths).toEqual([
      "secret/**",
      "vendor/**",
      ...ROOT_DENIES,
    ]);
  });

  test("AC-12: no configured denyPaths still denies the root instruction files", () => {
    const config = replaceConfig("replace");

    expect(instructionOptionsForSession("native", options(config)).instructionDenyPaths).toEqual(ROOT_DENIES);
  });

  test("a configured instructionFileName replaces the default trio with that one name", () => {
    const config = makeNaxConfig({
      context: { projectContext: { file: "/abs/org-context.md", mode: "replace" } },
      agent: { native: { instructionFileName: "TEAM.md" } },
      execution: { denyPaths: ["secret/**"] },
    });

    const out = instructionOptionsForSession("native", options(config));

    expect(out.instructionFileName).toBe("TEAM.md");
    expect(out.instructionDenyPaths).toEqual(["secret/**", "TEAM.md"]);
  });
});

describe("instructionOptionsForSession — append mode leaves the deny list alone (AC-13)", () => {
  test("AC-13: append mode with denyPaths returns exactly those denyPaths", () => {
    const config = makeNaxConfig({
      context: { projectContext: { file: "/abs/org-context.md", mode: "append" } },
      execution: { denyPaths: ["secret/**"] },
    });

    expect(instructionOptionsForSession("native", options(config)).instructionDenyPaths).toEqual(["secret/**"]);
  });

  test("mode defaults to append when a sparse config names only the file", () => {
    const config = makeNaxConfig({
      context: { projectContext: { file: "/abs/org-context.md" } },
      execution: { denyPaths: ["secret/**"] },
    });

    expect(instructionOptionsForSession("native", options(config)).instructionDenyPaths).toEqual(["secret/**"]);
  });

  test("append mode with no denyPaths leaves instructionDenyPaths undefined, as before", () => {
    const config = replaceConfig("append");

    expect(instructionOptionsForSession("native", options(config)).instructionDenyPaths).toBeUndefined();
  });

  test("replace mode with no configured file leaves the deny list untouched", () => {
    const config = makeNaxConfig({
      context: { projectContext: { mode: "replace" } },
      execution: { denyPaths: ["secret/**"] },
    });

    expect(instructionOptionsForSession("native", options(config)).instructionDenyPaths).toEqual(["secret/**"]);
  });
});

describe("instructionOptionsForSession — non-native sessions are unchanged (AC-14)", () => {
  test("AC-14: claude with replace mode returns the empty object", () => {
    expect(instructionOptionsForSession("claude", options(replaceConfig("replace")))).toEqual({});
  });

  test("AC-14: every non-native agent name returns the empty object", () => {
    for (const agent of ["claude", "codex", "gemini", "opencode", "acpx"]) {
      expect(instructionOptionsForSession(agent, options(replaceConfig("replace")))).toEqual({});
    }
  });
});

describe("instructionOptionsForSession — the rest of the native set is untouched", () => {
  test("replace mode still reports the instruction file, scopes and protected paths", () => {
    const config = makeNaxConfig({
      context: { projectContext: { file: "/abs/org-context.md", mode: "replace" } },
    });

    const out = instructionOptionsForSession("native", options(config, { codingToolPackageDir: "packages/api" }));

    expect(out.instructionFileName).toBe("AGENTS.md");
    expect(out.instructionDirectories).toEqual(["packages/api"]);
    expect(out.instructionProtectedPaths?.projectStateDir).toBe(".nax");
  });
});
