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
});

// ─────────────────────────────────────────────────────────────────────────────
// AC1: native unresolved id → blocker
// AC2: blocker message contains key path, provider, model id
// ─────────────────────────────────────────────────────────────────────────────

describe("checkModelResolution (US-1984 AC1/AC2) — native unresolved id", () => {
  // Test-exception: contract drift. The AC1/AC2 contract states "Given
  // `models.native.powerful` names a provider-qualified id absent from the
  // resolved catalog" — a precondition that requires the config to declare
  // a native entry. The original test stub passed `{}` and expected all
  // failing checks to be blockers, but `{}` falls through to DEFAULT_CONFIG
  // (all ACP sites). Resolved by passing the precondition config explicitly
  // (with a sentinel native entry the resolver reports as unresolved).
  test("AC1: returns a failing check with tier 'blocker' when models.native.powerful names an absent id", async () => {
    _modelResolutionDeps.resolveNative = async () => ({ status: "unresolved" });

    const checks = await checkModelResolution({
      models: { native: { powerful: "anthropic/never-shipped-model" } },
    });

    const failing = checks.filter((c) => !c.passed);
    expect(failing.length).toBeGreaterThan(0);
    const blocker = failing.find((f) => f.tier === "blocker");
    expect(blocker).toBeDefined();
  });

  test("AC2: the blocker message names the configuration key, provider, and model id", async () => {
    _modelResolutionDeps.resolveNative = async () => ({ status: "unresolved" });

    const checks = await checkModelResolution({
      models: { native: { powerful: "anthropic/never-shipped-model" } },
    });

    const blocker = checks.find((c) => !c.passed && c.tier === "blocker");
    expect(blocker).toBeDefined();
    expect(blocker?.message).toContain("models.native.powerful");
    expect(blocker?.message).toContain("provider=anthropic");
    expect(blocker?.message).toContain("model=never-shipped-model");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ACP ids are validated by acpx at dispatch time, not against a stale local mirror.
// ─────────────────────────────────────────────────────────────────────────────

describe("checkModelResolution — ACP ids are unverified", () => {
  // Test-exception: contract drift. The AC3 contract names the
  // `review.adversarial` literal pin. The original stub passed `{}` (which
  // falls back to DEFAULT_CONFIG's tier label "balanced", not a literal
  // pin). Resolved by passing a literal `{agent, model}` pin so the test
  // exercises the ACP literal-pin branch.
  test("does not emit a per-model failure for an ACP id", async () => {
    _modelResolutionDeps.resolveNative = async () => ({ status: "resolved" });

    const checks = await checkModelResolution({
      review: { adversarial: { model: { agent: "claude", model: "never-shipped-acp" } } },
    });

    expect(checks.filter((check) => !check.passed)).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC4: catalogOverrides makes an absent id resolvable
// ─────────────────────────────────────────────────────────────────────────────

describe("checkModelResolution (US-1984 AC4) — catalogOverrides resolve absent ids", () => {
  // Test-exception: contract drift. The AC4 contract says "an id absent from
  // the bundled catalog but declared under catalogOverrides has no failing
  // check" — that requires a config whose native entry points at exactly
  // the id the override declares. The original stub set up the override but
  // not the entry that references it, so the override was never exercised.
  // Resolved by passing both the native entry and the override list.
  test("AC4: an id absent from the bundled catalog but declared under catalogOverrides has no failing check", async () => {
    let resolverCalls = 0;
    _modelResolutionDeps.resolveNative = async () => {
      resolverCalls += 1;
      return { status: "resolved" };
    };

    const checks = await checkModelResolution({
      models: { native: { powerful: "opencode-go/new-model" } },
      agent: { native: { catalogOverrides: [{ provider: "opencode-go", models: [{ id: "new-model" }] }] } },
    });

    const failing = checks.filter((c) => !c.passed);
    expect(failing).toHaveLength(0);
    expect(resolverCalls).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC5: one failing check per literal pin site
// ─────────────────────────────────────────────────────────────────────────────

describe("checkModelResolution (US-1984 AC5) — one failing check per pin site", () => {
  // Test-exception: contract drift. Each row pairs the key path with the
  // minimum config the impl needs to surface that site; the original
  // test.each passed `{}` for every row, so the rows whose sites are not
  // in DEFAULT_CONFIG (the agent.fallback.map rungs in particular) had
  // nothing to walk.
  test.each([
    ["review.semantic.model", { review: { semantic: { model: { agent: "claude", model: "never-shipped-acp" } } } }],
    [
      "review.adversarial.model",
      { review: { adversarial: { model: { agent: "claude", model: "never-shipped-acp" } } } },
    ],
    ["plan.model", { plan: { model: { agent: "claude", model: "never-shipped-acp" } } }],
    ["acceptance.model", { acceptance: { model: { agent: "claude", model: "never-shipped-acp" } } }],
    [
      "tdd.sessionTiers.testWriter",
      { tdd: { sessionTiers: { testWriter: { agent: "claude", model: "never-shipped-acp" } } } },
    ],
    [
      "tdd.sessionTiers.verifier",
      { tdd: { sessionTiers: { verifier: { agent: "claude", model: "never-shipped-acp" } } } },
    ],
    ["routing.llm.model", { routing: { llm: { model: { agent: "claude", model: "never-shipped-acp" } } } }],
    [
      "autoMode.escalation.tierOrder[0].tier",
      { autoMode: { escalation: { tierOrder: [{ tier: "never-shipped-acp" }] } } },
    ],
    [
      "autoMode.escalation.tierOrder[1].tier",
      {
        autoMode: {
          escalation: { tierOrder: [{ tier: "fast" }, { tier: "never-shipped-acp" }] },
        },
      },
    ],
    [
      "agent.fallback.map.claude[0]",
      {
        agent: {
          fallback: {
            map: { claude: [{ agent: "claude", model: "never-shipped-acp" }] },
          },
        },
      },
    ],
    [
      "agent.fallback.map.claude[1]",
      {
        agent: {
          fallback: {
            map: {
              claude: [
                { agent: "claude", model: "sonnet" },
                { agent: "claude", model: "never-shipped-acp" },
              ],
            },
          },
        },
      },
    ],
  ])("does not emit a failure for the ACP %s site", async (keyPath, overrideConfig) => {
    _modelResolutionDeps.resolveNative = async () => ({ status: "unresolved" });

    const checks = await checkModelResolution(overrideConfig);

    const named = checks.filter((c) => !c.passed && c.message.includes(keyPath));
    expect(named).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC6: catalog resolver rejection → warning, not blocker
// ─────────────────────────────────────────────────────────────────────────────

describe("checkModelResolution (US-1984 AC6) — catalog resolver rejection is a warning", () => {
  test("AC6: when the native resolver rejects, the check returns a warning and no blocker", async () => {
    _modelResolutionDeps.resolveNative = async () => ({ status: "error" });

    const checks = await checkModelResolution({
      models: { native: { powerful: "anthropic/claude-sonnet-5" } },
    });

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

    const checks = await checkModelResolution({
      agent: { default: "native" },
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
