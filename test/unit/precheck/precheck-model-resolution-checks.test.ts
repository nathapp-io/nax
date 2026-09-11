/**
 * Tests for `checkModelResolution` — US-1984 (precheck configured model ids
 * and literal override loss).
 *
 * Covers AC1-AC8 at the check level (no runPrecheck integration). The check
 * is wired through `_modelResolutionDeps` so this file drives every
 * resolution outcome without loading the real bundled catalog.
 *
 * Stub contract (see src/precheck/checks-model-resolution.ts):
 *   `collectConfiguredModelPins(config)` returns the list of literal pin
 *   sites the check should walk. The stub returns [] (pass) until the
 *   implementer wires the collection; tests below assert the contract that
 *   the implementer must satisfy.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { _modelResolutionDeps, checkModelResolution, type ModelResolutionDeps } from "@/precheck/checks";

// ─────────────────────────────────────────────────────────────────────────────
// Setup / teardown — preserve the original deps so tests don't leak
// ─────────────────────────────────────────────────────────────────────────────

let originalDeps: ModelResolutionDeps;

beforeEach(() => {
  originalDeps = { ..._modelResolutionDeps };
});

afterEach(() => {
  _modelResolutionDeps.resolveNative = originalDeps.resolveNative;
  _modelResolutionDeps.resolveAcp = originalDeps.resolveAcp;
});

// ─────────────────────────────────────────────────────────────────────────────
// AC1: native unresolved id → blocker
// AC2: blocker message contains key path, provider, model id
// ─────────────────────────────────────────────────────────────────────────────

describe("checkModelResolution (US-1984 AC1/AC2) — native unresolved id", () => {
  test("AC1: returns a failing check with tier 'blocker' when models.native.powerful names an absent id", async () => {
    // Drive the resolver to report unresolved for any id the check sees.
    _modelResolutionDeps.resolveNative = async () => ({ status: "unresolved" });
    _modelResolutionDeps.resolveAcp = async () => ({ status: "unresolved" });

    const checks = await checkModelResolution({});

    const failing = checks.filter((c) => !c.passed);
    expect(failing.length).toBeGreaterThan(0);
    for (const f of failing) {
      expect(f.tier).toBe("blocker");
    }
  });

  test("AC2: the blocker message names the configuration key, provider, and model id", async () => {
    _modelResolutionDeps.resolveNative = async () => ({ status: "unresolved" });
    _modelResolutionDeps.resolveAcp = async () => ({ status: "unresolved" });

    // Contract: when an unresolved-native blocker is emitted, its message
    // must name the key path, the provider, and the model id. The implementer
    // wires `collectConfiguredModelPins` so this assertion either passes (the
    // three tokens are present) or fails loudly (any token missing). The stub
    // currently returns only a passing check, so the test fails here.
    const checks = await checkModelResolution({});

    const blocker = checks.find((c) => !c.passed && c.tier === "blocker");
    expect(blocker).toBeDefined();
    expect(blocker?.message).toContain("models.native.powerful");
    expect(blocker?.message).toContain("provider=");
    expect(blocker?.message).toContain("model=");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC3: ACP literal pin → warning, not blocker
// ─────────────────────────────────────────────────────────────────────────────

describe("checkModelResolution (US-1984 AC3) — ACP unresolved id is a warning", () => {
  test("AC3: an unresolvable ACP id at review.adversarial yields a warning and no blocker", async () => {
    // Native resolves everything (so the blocker branch is silent).
    _modelResolutionDeps.resolveNative = async () => ({ status: "resolved" });
    // ACP reports unresolved — the adversarial pin site is what AC3 names.
    _modelResolutionDeps.resolveAcp = async () => ({ status: "unresolved" });

    const checks = await checkModelResolution({});

    const blockers = checks.filter((c) => !c.passed && c.tier === "blocker");
    expect(blockers).toHaveLength(0);
    const warnings = checks.filter((c) => !c.passed && c.tier === "warning");
    expect(warnings.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC4: catalogOverrides makes an absent id resolvable
// ─────────────────────────────────────────────────────────────────────────────

describe("checkModelResolution (US-1984 AC4) — catalogOverrides resolve absent ids", () => {
  test("AC4: an id absent from the bundled catalog but declared under catalogOverrides has no failing check", async () => {
    // The resolver returns "unresolved" — as it would for an id that is
    // absent from the bundled catalog. The check must still pass because
    // the override table short-circuits the catalog lookup.
    _modelResolutionDeps.resolveNative = async () => ({ status: "unresolved" });
    _modelResolutionDeps.resolveAcp = async () => ({ status: "resolved" });

    const checks = await checkModelResolution({
      agent: { native: { catalogOverrides: [{ provider: "opencode-go", models: [{ id: "new-model" }] }] } },
    });

    const failing = checks.filter((c) => !c.passed);
    // Contract: the override list must short-circuit the catalog lookup, so
    // no failing check for any id the user declared. Stub returns one
    // passing check today; the contract test fails if the implementer
    // forgets to thread `catalogOverrides` into the resolver (because the
    // resolver would otherwise return "unresolved").
    expect(failing).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC5: one failing check per literal pin site
// ─────────────────────────────────────────────────────────────────────────────

describe("checkModelResolution (US-1984 AC5) — one failing check per pin site", () => {
  test.each([
    ["review.semantic.model"],
    ["review.adversarial.model"],
    ["plan.model"],
    ["acceptance.model"],
    ["tdd.sessionTiers.testWriter"],
    ["tdd.sessionTiers.verifier"],
    ["routing.llm.model"],
    ["autoMode.escalation.tierOrder[0].tier"],
    ["autoMode.escalation.tierOrder[1].tier"],
    ["agent.fallback.map.claude[0]"],
    ["agent.fallback.map.claude[1]"],
  ])("AC5: emits one failing check naming the %s site", async (keyPath) => {
    _modelResolutionDeps.resolveNative = async () => ({ status: "unresolved" });
    _modelResolutionDeps.resolveAcp = async () => ({ status: "unresolved" });

    const checks = await checkModelResolution({});

    // Contract: the implementer must wire `collectConfiguredModelPins` so
    // every supported site produces a Check whose message names its key
    // path. The stub returns a single passing check today; this assertion
    // fails until the wiring is in place.
    const named = checks.filter((c) => !c.passed && c.message.includes(keyPath));
    expect(named.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC6: catalog resolver rejection → warning, not blocker
// ─────────────────────────────────────────────────────────────────────────────

describe("checkModelResolution (US-1984 AC6) — catalog resolver rejection is a warning", () => {
  test("AC6: when the native resolver rejects, the check returns a warning and no blocker", async () => {
    _modelResolutionDeps.resolveNative = async () => ({ status: "error" });
    _modelResolutionDeps.resolveAcp = async () => ({ status: "error" });

    const checks = await checkModelResolution({});

    const blockers = checks.filter((c) => !c.passed && c.tier === "blocker");
    expect(blockers).toHaveLength(0);
    const warnings = checks.filter((c) => !c.passed && c.tier === "warning");
    expect(warnings.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC7: literal pin dropping pricing/contextWindow → warning
// ─────────────────────────────────────────────────────────────────────────────

describe("checkModelResolution (US-1984 AC7) — literal pin drops overrides", () => {
  test("AC7: literal pin naming a tier-configured model emits a warning naming the pin, model id, and catalogOverrides", async () => {
    _modelResolutionDeps.resolveNative = async () => ({ status: "resolved" });
    _modelResolutionDeps.resolveAcp = async () => ({ status: "resolved" });

    const checks = await checkModelResolution({
      models: {
        native: {
          balanced: {
            provider: "anthropic",
            model: "claude-sonnet-5",
            pricing: { inputPer1M: 3, outputPer1M: 15 },
            contextWindow: 1_000_000,
          },
        },
      },
      review: {
        adversarial: { model: { agent: "native", model: "claude-sonnet-5" } },
      },
    });

    const warning = checks.find((c) => !c.passed && c.tier === "warning");
    expect(warning).toBeDefined();
    expect(warning?.message).toContain("review.adversarial");
    expect(warning?.message).toContain("claude-sonnet-5");
    expect(warning?.message).toContain("agent.native.catalogOverrides");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC8: tier selection drops no warnings
// ─────────────────────────────────────────────────────────────────────────────

describe("checkModelResolution (US-1984 AC8) — tier selection drops no warnings", () => {
  test("AC8: a tier name that names the same id produces no dropped-overrides warning", async () => {
    _modelResolutionDeps.resolveNative = async () => ({ status: "resolved" });
    _modelResolutionDeps.resolveAcp = async () => ({ status: "resolved" });

    const checks = await checkModelResolution({
      models: {
        native: {
          balanced: {
            provider: "anthropic",
            model: "claude-sonnet-5",
            pricing: { inputPer1M: 3, outputPer1M: 15 },
            contextWindow: 1_000_000,
          },
        },
      },
      plan: { model: "balanced" }, // tier name, not literal pin
    });

    const overrideLoss = checks.find(
      (c) => !c.passed && c.tier === "warning" && c.message.includes("catalogOverrides"),
    );
    expect(overrideLoss).toBeUndefined();
  });
});
