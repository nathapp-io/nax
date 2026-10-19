/**
 * US-002 — `nax run --rules-dir` / `--context-file` → `cliOverrides.context`.
 *
 * `resolveRunProjectContext` (bin/run-action.ts) hands its flag values to
 * `resolveContextCliOverrides`, which is where the translation lives: the
 * mapping is extracted because `bin/` has no unit test of its own and `../../`
 * imports are banned (the same reason `run-max-iterations.ts`, `run-parallel.ts`
 * and `run-mode.ts` live in `src/cli/`).
 *
 * What matters for the operator is the path anchor. `nax run -d <dir>` may be
 * launched from anywhere, so a relative flag value is joined onto the run's
 * workdir; an absolute value, or a `~/` one the config schema expands, is passed
 * through untouched.
 *
 * The AC id is the test-name prefix.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { resolveCliOverridePath, resolveContextCliOverrides } from "@/cli/run-context-overrides";

const WORKDIR = "/repo";

describe("resolveContextCliOverrides — --rules-dir / --context-file (US-002)", () => {
  test("AC-7: a relative rulesDir is joined onto the run's workdir", () => {
    const overrides = resolveContextCliOverrides(WORKDIR, { rulesDir: "org-rules" });

    expect(overrides?.rules).toEqual({ overrideDir: join(WORKDIR, "org-rules") });
  });

  test("AC-8: a '~/'-prefixed rulesDir passes through for the config schema to expand", () => {
    const overrides = resolveContextCliOverrides(WORKDIR, { rulesDir: "~/r" });

    expect(overrides?.rules).toEqual({ overrideDir: "~/r" });
  });

  test("AC-9: an absolute contextFile passes through unchanged", () => {
    const overrides = resolveContextCliOverrides(WORKDIR, { contextFile: "/abs/c.md" });

    expect(overrides?.projectContext).toEqual({ file: "/abs/c.md" });
  });

  test("both flags together produce one context override block", () => {
    const overrides = resolveContextCliOverrides(WORKDIR, { rulesDir: "org-rules", contextFile: "ctx.md" });

    expect(overrides).toEqual({
      rules: { overrideDir: join(WORKDIR, "org-rules") },
      projectContext: { file: join(WORKDIR, "ctx.md") },
    });
  });

  test("neither flag yields undefined, so the config's own values stay in place", () => {
    expect(resolveContextCliOverrides(WORKDIR, {})).toBeUndefined();
  });

  test("an explicitly absolute rulesDir is not re-anchored on the workdir", () => {
    const overrides = resolveContextCliOverrides(WORKDIR, { rulesDir: "/abs/org-rules" });

    expect(overrides?.rules).toEqual({ overrideDir: "/abs/org-rules" });
  });
});

describe("resolveCliOverridePath (US-002)", () => {
  test("a bare '~' is not a shorthand and is anchored on the workdir", () => {
    expect(resolveCliOverridePath(WORKDIR, "~")).toBe(join(WORKDIR, "~"));
  });

  test("a '~/'-prefixed value is left for the schema to expand", () => {
    expect(resolveCliOverridePath(WORKDIR, "~/fleet/rules")).toBe("~/fleet/rules");
  });
});
