/**
 * Every CallContext built from a PipelineContext must forward the per-story
 * effective config (nax#2066). Without it the `CallContext.config` field is
 * never set in production and the fix is inert — the declared-but-unreachable
 * failure mode this change exists to close.
 *
 * A convention check rather than a behavioural one: each of these sites needs a
 * large pipeline fixture to drive, and the behavioural half (callOp honouring
 * the field) is pinned by call-effective-config.test.ts. This test guards the
 * wiring itself, which is the half that silently rots.
 */

import { describe, expect, test } from "bun:test";

// Each entry: the file, and the literal that must carry a `config:` entry.
const SITES: readonly { file: string; marker: string }[] = [
  { file: "src/pipeline/stages/execution.ts", marker: "const callCtx: CallContext = {" },
  {
    file: "src/pipeline/stages/acceptance-setup.ts",
    marker: "packageView: pipelineCtx.runtime.packages.resolve(packageDir),",
  },
  {
    file: "src/execution/lifecycle/acceptance-fix.ts",
    marker: "packageView: ctx.runtime.packages.resolve(ctx.workdir),",
  },
  { file: "src/execution/lifecycle/acceptance-loop.ts", marker: "packageView: runtime.packages.resolve(packageDir)," },
  { file: "src/finish/phase.ts", marker: "packageView: ctx.runtime.packages.resolve(ctx.workdir)," },
];

describe("pipeline CallContext sites forward the effective config (#2066)", () => {
  for (const site of SITES) {
    test(`${site.file} sets config on its CallContext literal`, async () => {
      const source = await Bun.file(site.file).text();
      const at = source.indexOf(site.marker);
      expect(at).toBeGreaterThan(-1); // marker drifted — re-anchor this entry
      // Scan a window past the marker, not the whole file, so an unrelated
      // `config:` elsewhere cannot make this pass.
      expect(source.slice(at, at + 600)).toContain("config:");
    });
  }

  test("hardening.ts sets config on both of its CallContext literals", async () => {
    const source = await Bun.file("src/acceptance/hardening.ts").text();
    const occurrences = source.split("packageView: ctx.runtime.packages.resolve(packageDir),");
    expect(occurrences.length).toBe(3); // two sites => three fragments
    for (const fragment of occurrences.slice(1)) {
      expect(fragment.slice(0, 600)).toContain("config:");
    }
  });
});
