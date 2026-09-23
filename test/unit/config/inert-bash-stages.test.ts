/**
 * Unit tests for src/config/inert-bash-stages.ts — US-003
 * "Warn when gated or escalate stages cannot offer Bash".
 *
 * `findInertBashStages` is a pure read of `resolvePermissions(config, stage)`:
 * a stage is inert when its resolved `bashApproval` is `gated`/`escalate` AND no
 * entry of its resolved grants has `tool === "Bash"`. The whole point is that it
 * cannot disagree with `resolveBashSupport` (the tool-offer path), so AC7 pins
 * that agreement directly rather than restating the grant list.
 *
 * Configs come from the sanctioned `makeNaxConfig` factory; nothing here
 * touches the loader, so an out-of-enum `permissionProfile` (AC8) is injected
 * onto the parsed config the way a schema-bypassing caller would reach the
 * resolver's fail-closed arm.
 */

import { describe, expect, test } from "bun:test";
import { type DeepPartial, makeNaxConfig } from "@test/helpers";
import { resolveBashSupport } from "@/agents/coding-tool-bash";
import type { NaxConfig, PipelineStage } from "@/config";
import { BASH_DECLARING_STAGES, findInertBashStages } from "@/config";
import { resolvePermissions } from "@/config/permissions";
import {
  acceptanceFixSourceOp,
  acceptanceFixTestOp,
  finishFixOp,
  fullSuiteRectifyOp,
  implementerOp,
  implementerRectifyOp,
  rectifyOp,
  testWriterOp,
  testWriterRectifyOp,
} from "@/operations";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function configWith(execution: DeepPartial<NaxConfig["execution"]> = {}): NaxConfig {
  return makeNaxConfig({ execution });
}

/**
 * `permissions.<stage>.allow` is not declared on the runtime `NaxConfig`
 * execution type — that interface predates the rule lists the resolver reads
 * (it carries only the legacy `allowedTools`), while the zod schema does carry
 * them and `resolvePermissions` reads them through its own structural view.
 * The deny suite builds the same shape through a `Record<string, unknown>` for
 * the same reason; doing it here keeps the AC-literal `allow` key and adds no
 * cast. The rest of the slice stays type-checked at the call site.
 */
function configWithPermissions(
  execution: DeepPartial<NaxConfig["execution"]>,
  permissions: Record<string, unknown>,
): NaxConfig {
  const merged: Record<string, unknown> = { ...execution, permissions };
  return makeNaxConfig({ execution: merged });
}

/** Order-insensitive view: the story pins membership, not the result's order. */
function sorted(stages: readonly PipelineStage[]): string[] {
  return [...stages].sort((a, b) => a.localeCompare(b));
}

const OTHER_THREE: PipelineStage[] = ["acceptance", "rectification", "review"];

/**
 * The nine operations that declare the Bash tool, with the stage each
 * dispatches on. AC9 is the reason this list exists in the test at all: the
 * constant is only correct if it covers exactly these.
 */
const BASH_DECLARING_OPS: Array<[string, { stage: PipelineStage; tools?: readonly string[] }]> = [
  ["implementerOp", implementerOp],
  ["testWriterOp", testWriterOp],
  ["rectifyOp", rectifyOp],
  ["fullSuiteRectifyOp", fullSuiteRectifyOp],
  ["finishFixOp", finishFixOp],
  ["implementerRectifyOp", implementerRectifyOp],
  ["testWriterRectifyOp", testWriterRectifyOp],
  ["acceptanceFixSourceOp", acceptanceFixSourceOp],
  ["acceptanceFixTestOp", acceptanceFixTestOp],
];

// ─────────────────────────────────────────────────────────────────────────────
// US-003 AC1 — escalate + unrestricted + no permissions block
// ─────────────────────────────────────────────────────────────────────────────

describe("findInertBashStages — US-003 AC1: escalate with no rule at all", () => {
  test("AC1: escalate, unrestricted profile and no permissions block leaves every declaring stage inert", () => {
    const config = configWith({ bashApproval: "escalate", permissionProfile: "unrestricted" });
    // Premise of the AC: nothing in the config grants Bash.
    expect(config.execution.permissions).toBeUndefined();

    expect(sorted(findInertBashStages(config))).toEqual(sorted(BASH_DECLARING_STAGES));
  });

  test("AC1 boundary: the safe profile grants no Bash either, so escalate leaves every declaring stage inert", () => {
    const config = configWith({ bashApproval: "escalate", permissionProfile: "safe" });

    expect(sorted(findInertBashStages(config))).toEqual(sorted(BASH_DECLARING_STAGES));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-003 AC2 — a Bash(...) rule on run
// ─────────────────────────────────────────────────────────────────────────────

describe("findInertBashStages — US-003 AC2: a Bash allow rule un-inerts its stage", () => {
  test("AC2: a Bash(ls *) rule on run keeps run out of the inert list", () => {
    const config = configWithPermissions({ bashApproval: "escalate" }, { run: { allow: ["Bash(ls *)"] } });

    const inert = findInertBashStages(config);
    expect(inert).not.toContain("run");
    expect(sorted(inert)).toEqual(sorted(OTHER_THREE));
  });

  test("AC2 boundary: an Exec(...) rule on run is not a Bash grant, so run stays inert", () => {
    const config = configWithPermissions({ bashApproval: "escalate" }, { run: { allow: ["Exec(bun test*)"] } });

    expect(findInertBashStages(config)).toContain("run");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-003 AC3 — gated with no Bash(...) rule
// ─────────────────────────────────────────────────────────────────────────────

describe("findInertBashStages — US-003 AC3: gated behaves as escalate does", () => {
  test("AC3: gated with no Bash(...) rule leaves every declaring stage inert", () => {
    const config = configWith({ bashApproval: "gated" });

    expect(sorted(findInertBashStages(config))).toEqual(sorted(BASH_DECLARING_STAGES));
  });

  test("AC3 boundary: gated with a Bash(...) rule on run keeps run out of the inert list", () => {
    const config = configWithPermissions({ bashApproval: "gated" }, { run: { allow: ["Bash(git status*)"] } });

    expect(findInertBashStages(config)).not.toContain("run");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-003 AC4 — raw never gates
// ─────────────────────────────────────────────────────────────────────────────

describe("findInertBashStages — US-003 AC4: raw is never inert", () => {
  test("AC4: raw returns an empty list", () => {
    expect(findInertBashStages(configWith({ bashApproval: "raw" }))).toEqual([]);
  });

  test("AC4 boundary: raw stays empty even when a Bash(...) rule exists (raw does not gate)", () => {
    const config = configWithPermissions({ bashApproval: "raw" }, { run: { allow: ["Bash(ls *)"] } });

    expect(findInertBashStages(config)).toEqual([]);
  });

  test("AC4 boundary: an absent bashApproval resolves to the raw default, so nothing is inert", () => {
    expect(findInertBashStages(makeNaxConfig())).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-003 AC5 — per-stage override of a raw global
// ─────────────────────────────────────────────────────────────────────────────

describe("findInertBashStages — US-003 AC5: per-stage override wins over the global mode", () => {
  test("AC5: global raw + permissions.review.bashApproval escalate returns exactly review", () => {
    const config = configWith({
      bashApproval: "raw",
      permissions: { review: { bashApproval: "escalate" } },
    });

    expect([...findInertBashStages(config)]).toEqual(["review"]);
  });

  test("AC5 boundary: an escalate override on a stage that declares no Bash is never reported", () => {
    const config = configWith({
      bashApproval: "raw",
      permissions: { plan: { bashApproval: "escalate" } },
    });

    expect(findInertBashStages(config)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-003 AC6 — never a stage outside BASH_DECLARING_STAGES
// ─────────────────────────────────────────────────────────────────────────────

describe("findInertBashStages — US-003 AC6: the result is confined to declaring stages", () => {
  test("AC6: a gated config with no rule reports only declaring stages, never plan/verify/setup/complete", () => {
    const inert = findInertBashStages(configWith({ bashApproval: "gated" }));

    expect(sorted(inert)).toEqual(sorted(BASH_DECLARING_STAGES));
    for (const stage of ["plan", "verify", "setup", "regression", "complete"] as const) {
      expect(inert).not.toContain(stage);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-003 AC7 — agreement with resolveBashSupport
// ─────────────────────────────────────────────────────────────────────────────

describe("findInertBashStages — US-003 AC7: agrees with resolveBashSupport", () => {
  test("AC7: a granted run yields allowBash with a Bash grant, and run is not inert", () => {
    const config = configWithPermissions({ bashApproval: "escalate" }, { run: { allow: ["Bash(ls *)"] } });
    const resolved = resolvePermissions(config, "run");

    const support = resolveBashSupport({
      declared: ["Bash"],
      grants: resolved.toolGrants ?? [],
      bashApproval: resolved.bashApproval,
    });

    expect(support.allowBash).toBe(true);
    expect(support.effectiveGrants.some((grant) => grant.tool === "Bash")).toBe(true);
    expect(findInertBashStages(config)).not.toContain("run");
  });

  test("AC7 boundary: with no Bash(...) rule the tool is still declared but no grant exists, and run is inert", () => {
    const config = configWith({ bashApproval: "escalate" });
    const resolved = resolvePermissions(config, "run");

    const support = resolveBashSupport({
      declared: ["Bash"],
      grants: resolved.toolGrants ?? [],
      bashApproval: resolved.bashApproval,
    });

    expect(support.allowBash).toBe(true);
    expect(support.effectiveGrants.some((grant) => grant.tool === "Bash")).toBe(false);
    expect(findInertBashStages(config)).toContain("run");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-003 AC8 — an unrecognised permissionProfile fails closed, without throwing
// ─────────────────────────────────────────────────────────────────────────────

describe("findInertBashStages — US-003 AC8: out-of-enum permissionProfile", () => {
  test("AC8: an out-of-enum profile does not throw and leaves every declaring stage inert", () => {
    const config = configWith({ bashApproval: "escalate" });
    // Bypasses schema validation on purpose: the resolver's fail-closed arm
    // (no toolGrants, bashApproval gated) is only reachable this way.
    Object.assign(config.execution, { permissionProfile: "not-a-profile" });

    expect(() => findInertBashStages(config)).not.toThrow();
    expect(sorted(findInertBashStages(config))).toEqual(sorted(BASH_DECLARING_STAGES));
  });

  test("AC8 boundary: the fail-closed arm discards stage rules, so an explicit Bash(...) rule cannot un-inert run", () => {
    const config = configWithPermissions({ bashApproval: "escalate" }, { run: { allow: ["Bash(ls *)"] } });
    Object.assign(config.execution, { permissionProfile: "not-a-profile" });

    expect(findInertBashStages(config)).toContain("run");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-003 AC9 — the constant mirrors the operations that declare Bash
// ─────────────────────────────────────────────────────────────────────────────

describe("BASH_DECLARING_STAGES — US-003 AC9: mirrors the Bash-declaring operations", () => {
  test.each(BASH_DECLARING_OPS)(
    "AC9: %s declares the Bash tool and dispatches on a BASH_DECLARING_STAGES stage",
    (_name, op) => {
      expect(op.tools).toContain("Bash");
      expect([...BASH_DECLARING_STAGES]).toContain(op.stage);
    },
  );

  test("AC9 boundary: BASH_DECLARING_STAGES names exactly the stages those nine operations use", () => {
    const opStages = [...new Set(BASH_DECLARING_OPS.map(([, op]) => op.stage))].sort((a, b) => a.localeCompare(b));

    expect([...BASH_DECLARING_STAGES].sort((a, b) => a.localeCompare(b))).toEqual(opStages);
  });
});
