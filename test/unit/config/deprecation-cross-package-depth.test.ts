/**
 * context.v2.providers.crossPackageDepth removal (nax#2074).
 *
 * Zod runs in .strip() mode, so an unknown key would load SILENTLY. A removed
 * knob that vanishes without a word is the declared-but-inert class this
 * change exists to close, so the shim warns and drops it explicitly.
 */

import { describe, expect, test } from "bun:test";
import { _applyRemovedCrossPackageDepthShim } from "@/config/compat-shims";

describe("_applyRemovedCrossPackageDepthShim", () => {
  test("warns once and drops the key, leaving sibling provider keys intact", () => {
    const warnings: string[] = [];
    const conf = {
      context: { v2: { providers: { neighborScope: "package", crossPackageDepth: 2, maxGlobFiles: 500 } } },
    };

    const out = _applyRemovedCrossPackageDepthShim(conf, (m) => warnings.push(m));

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("context.v2.providers.crossPackageDepth");
    const providers = (out.context as { v2: { providers: Record<string, unknown> } }).v2.providers;
    expect("crossPackageDepth" in providers).toBe(false);
    expect(providers.neighborScope).toBe("package");
    expect(providers.maxGlobFiles).toBe(500);
  });

  test("is a no-op — same object, no warning — when the key is absent", () => {
    const warnings: string[] = [];
    const conf = { context: { v2: { providers: { neighborScope: "repo" } } } };

    const out = _applyRemovedCrossPackageDepthShim(conf, (m) => warnings.push(m));

    expect(out).toBe(conf);
    expect(warnings).toHaveLength(0);
  });

  test("does not mutate the input config", () => {
    const conf = { context: { v2: { providers: { crossPackageDepth: 1 } } } };

    _applyRemovedCrossPackageDepthShim(conf, () => {});

    expect((conf.context.v2.providers as Record<string, unknown>).crossPackageDepth).toBe(1);
  });

  test("leaves a config with no context block alone", () => {
    const conf = { review: {} };
    expect(_applyRemovedCrossPackageDepthShim(conf, () => {})).toBe(conf);
  });
});
