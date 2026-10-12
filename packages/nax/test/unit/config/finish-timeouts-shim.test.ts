import { describe, expect, test } from "bun:test";
import { _applyFinishStepTimeoutShim } from "@/config/finish-timeouts-shim";

describe("_applyFinishStepTimeoutShim (finish A)", () => {
  test("copies a numeric stepMs into reviewMs and fixMs, drops stepMs and warns", () => {
    const warnings: string[] = [];
    const out = _applyFinishStepTimeoutShim({ finish: { timeouts: { stepMs: 600_000, gateMs: 1 } } }, (m) =>
      warnings.push(m),
    );
    expect(out).toEqual({ finish: { timeouts: { gateMs: 1, reviewMs: 600_000, fixMs: 600_000 } } });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("finish.timeouts.stepMs");
  });

  test("an explicit reviewMs / fixMs wins over stepMs", () => {
    expect(
      _applyFinishStepTimeoutShim({ finish: { timeouts: { stepMs: 600_000, reviewMs: 1_000 } } }, () => {}),
    ).toEqual({
      finish: { timeouts: { reviewMs: 1_000, fixMs: 600_000 } },
    });
  });

  test("a null stepMs is dropped silently", () => {
    const warnings: string[] = [];
    expect(_applyFinishStepTimeoutShim({ finish: { timeouts: { stepMs: null } } }, (m) => warnings.push(m))).toEqual({
      finish: { timeouts: {} },
    });
    expect(warnings).toEqual([]);
  });

  test("returns the same object when there is no stepMs, and never mutates the input", () => {
    const plain = { finish: { timeouts: { gateMs: 1 } } };
    expect(_applyFinishStepTimeoutShim(plain, () => {})).toBe(plain);
    const legacy = { finish: { timeouts: { stepMs: 5 } } };
    _applyFinishStepTimeoutShim(legacy, () => {});
    expect(legacy).toEqual({ finish: { timeouts: { stepMs: 5 } } });
  });
});
