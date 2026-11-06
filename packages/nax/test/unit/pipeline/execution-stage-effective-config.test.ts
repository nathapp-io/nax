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

// Each entry: the file, the literal that must carry a `config:` entry, and an
// optional scan window (default 600) narrow enough to exclude unrelated
// `config:` entries further down the file.
const SITES: readonly { file: string; marker: string; window?: number }[] = [
  { file: "src/pipeline/stages/execution.ts", marker: "const callCtx: CallContext = {" },
];

describe("pipeline CallContext sites forward the effective config (#2066)", () => {
  for (const site of SITES) {
    test(`${site.file} sets config on its CallContext literal`, async () => {
      const source = await Bun.file(site.file).text();
      const at = source.indexOf(site.marker);
      expect(at).toBeGreaterThan(-1); // marker drifted — re-anchor this entry
      // Scan a window past the marker, not the whole file, so an unrelated
      // `config:` elsewhere cannot make this pass.
      expect(source.slice(at, at + (site.window ?? 600))).toContain("config:");
    });
  }
});
