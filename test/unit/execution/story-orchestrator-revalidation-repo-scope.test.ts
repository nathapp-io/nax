/**
 * Revalidation routing for the repo-scoped test-fix strategy (#1654).
 *
 * `phasesToRevalidate` falls back to re-running EVERY phase when it meets a
 * strategy name absent from `STRATEGY_TO_REVALIDATION_PHASES`. That fallback is
 * safe by design but wrong here: "every phase" includes `test-writer` and
 * `implementer`, so a strategy that merely fixed a failing test would re-run the
 * story's authoring sessions. The mapping has to be declared, not inherited.
 */

import { describe, expect, test } from "bun:test";
import type { PhaseKind } from "@/execution";
import { phasesToRevalidate } from "@/execution";
import { STRATEGY_TO_REVALIDATION_PHASES } from "@/execution/story-orchestrator";

const ALL_PHASE_KINDS: PhaseKind[] = [
  "test-writer",
  "greenfield-gate",
  "implementer",
  "test-presence-gate",
  "full-suite-gate",
  "mutation-check",
  "verifier",
  "verify-scoped",
  "lint-check",
  "typecheck-check",
  "semantic-review",
  "adversarial-review",
];

const allPhases = ALL_PHASE_KINDS.map((kind) => ({ kind }) as any);

describe("repo-scoped-test-fix revalidation mapping (#1654)", () => {
  test("is declared in the SSOT map, not left to the unknown-strategy fallback", () => {
    expect(STRATEGY_TO_REVALIDATION_PHASES["repo-scoped-test-fix"]).toBeDefined();
  });

  test("re-runs the same phases as full-suite-rectify", () => {
    // It fixes failing tests through the same op and may edit tests via the same
    // declaration protocol, so the verifier and both reviews go stale in exactly
    // the same way. A wider file scope does not change which phases are affected.
    expect(STRATEGY_TO_REVALIDATION_PHASES["repo-scoped-test-fix"]).toEqual(
      STRATEGY_TO_REVALIDATION_PHASES["full-suite-rectify"],
    );
  });

  test("does not re-run the story's authoring phases", () => {
    const kinds = phasesToRevalidate(["repo-scoped-test-fix"], allPhases).map((p) => p.kind);
    expect(kinds).not.toContain("test-writer");
    expect(kinds).not.toContain("implementer");
    expect(kinds).not.toContain("greenfield-gate");
  });

  test("re-runs the gate that produced the finding", () => {
    const kinds = phasesToRevalidate(["repo-scoped-test-fix"], allPhases).map((p) => p.kind);
    expect(kinds).toContain("full-suite-gate");
  });

  test("co-running with full-suite-rectify does not widen the set", () => {
    const solo = phasesToRevalidate(["repo-scoped-test-fix"], allPhases).map((p) => p.kind);
    const both = phasesToRevalidate(["full-suite-rectify", "repo-scoped-test-fix"], allPhases).map((p) => p.kind);
    expect(both).toEqual(solo);
  });
});
