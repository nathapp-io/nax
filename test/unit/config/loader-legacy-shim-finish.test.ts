/**
 * Tests for `_applyFinishAutoFlowShim` — the compat shim that lifts the removed
 * `finish.autoFlow.*` config shape onto the flattened `finish.*` shape.
 *
 * Split out of `loader-legacy-shim.test.ts` (which owns the rest of the
 * compat-shim chain) once adding this describe block pushed that file over the
 * 800-line test file limit.
 */

import { describe, expect, test } from "bun:test";
import { _applyFinishAutoFlowShim } from "@/config/compat-shims";

describe("_applyFinishAutoFlowShim", () => {
  test("lifts finish.autoFlow.* onto finish.* and drops the removed keys", () => {
    const warnings: string[] = [];
    const out = _applyFinishAutoFlowShim(
      {
        finish: {
          autoFlow: {
            enabled: true,
            flowPath: "flows/nax-finish/nax-finish.flow.ts",
            defaultAgent: "claude",
            model: "sonnet",
            narrative: false,
            timeouts: { acceptanceMs: 1, gateMs: 2, flowMs: 3, stepMs: 4 },
          },
        },
      },
      (m) => warnings.push(m),
    );
    expect(out.finish).toEqual({
      enabled: true,
      narrative: false,
      timeouts: { acceptanceMs: 1, gateMs: 2, flowMs: 3, stepMs: 4 },
    });
    expect(warnings.join(" ")).toContain("finish.autoFlow");
  });

  test("maps a reviewer profile string to null and warns, rather than failing validation", () => {
    const warnings: string[] = [];
    const out = _applyFinishAutoFlowShim(
      {
        finish: { autoFlow: { enabled: true, reviewers: { spec: "nax-finish-spec", quality: null, narrative: null } } },
      },
      (m) => warnings.push(m),
    );
    expect((out.finish as { reviewers: Record<string, unknown> }).reviewers).toEqual({
      spec: null,
      quality: null,
      narrative: null,
    });
    expect(warnings.join(" ")).toContain("reviewers.spec");
  });

  test("an explicit finish.* alongside finish.autoFlow wins", () => {
    const out = _applyFinishAutoFlowShim({ finish: { enabled: false, autoFlow: { enabled: true } } }, () => {});
    expect((out.finish as { enabled: boolean }).enabled).toBe(false);
  });

  test("a config with no finish block is returned unchanged, same reference", () => {
    const conf = { review: {} };
    expect(_applyFinishAutoFlowShim(conf, () => {})).toBe(conf);
  });
});
