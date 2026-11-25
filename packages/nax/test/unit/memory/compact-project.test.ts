/**
 * compact-project.test.ts — the deterministic half of one compaction: what it
 * refuses before spending a model call, what it reads, what it validates, and
 * what it writes only once a person says yes.
 *
 * Covers AC-1..AC-5 and AC-9..AC-18. The dispatch itself (what the op is given)
 * and the fill read back after an apply are `test/integration/memory/compact-
 * project.test.ts`'s.
 *
 * Every case runs the real orchestration over the harness in
 * `test/helpers/compact-project.ts`: a host double for the mirror, and three
 * recorded seams for the facts, the call context and the model call. No case
 * makes a billed call, and none needs a runtime booted.
 */

import { describe, expect, test } from "bun:test";
import type { MemoryCompactionPlan } from "@nathapp/nax-agent/internal";
import {
  COMPACT_CANDIDATES,
  COMPACT_CONFIG,
  COMPACT_PENDING_NOTE,
  COMPACT_PLAN,
  COMPACT_PREVIEW,
  COMPACT_REPO_ROOT,
  COMPACT_RESULT,
  COMPACT_REUSE_PLAN,
  makeCompactProjectHarness,
  makeNaxConfig,
  withDepsRestore,
  withTempDir,
} from "@test/helpers";
import { _compactProjectDeps, compactProjectMemory } from "@/memory";

/** A plan whose only merge targets an existing note that is not one of its sources. */
const COLLIDING_PLAN: MemoryCompactionPlan = {
  retire: [],
  merge: [
    {
      from: ["beta"],
      into: { slug: "delta", type: "project", description: "takes a taken slug", body: "collided body" },
    },
  ],
};

/** The two reasons that plan is refused with, in the order the validator reports them. */
const COLLISION_REASONS = [
  'merge into "delta": a merge needs at least 2 sources, it lists 1',
  'merge target "delta": the slug already exists and is not one of the merge\'s own sources',
];

describe("compactProjectMemory", () => {
  withDepsRestore(_compactProjectDeps);

  // AC-1
  test("answers unsupported, without a model call, when the host has no compactionCandidates", async () => {
    const h = makeCompactProjectHarness({ capabilities: false });

    expect(await compactProjectMemory(h.input)).toEqual({ kind: "unsupported" });
    expect(h.calls.dispatch).toEqual([]);
  });

  // AC-2
  test("answers unsupported, without a model call, when the host writes proposals", async () => {
    const h = makeCompactProjectHarness({ writeMode: "proposal" });

    expect(await compactProjectMemory(h.input)).toEqual({ kind: "unsupported" });
    expect(h.calls.dispatch).toEqual([]);
  });

  // AC-3
  test("answers nothing-to-compact with the fill, and reads no facts, when no note is a candidate", async () => {
    const h = makeCompactProjectHarness({ candidates: [] });

    expect(await compactProjectMemory(h.input)).toEqual({ kind: "nothing-to-compact", fill: 0.5 });
    expect(h.calls.dispatch).toEqual([]);
    expect(h.calls.readFacts).toEqual([]);
  });

  // AC-4
  test("reads the repository facts once, for the repository root", async () => {
    const h = makeCompactProjectHarness();

    await compactProjectMemory(h.input);

    expect(h.calls.readFacts).toEqual([COMPACT_REPO_ROOT]);
  });

  // AC-5
  test("builds the call context once, from the loaded config and the repository root", async () => {
    const h = makeCompactProjectHarness();

    await compactProjectMemory(h.input);

    expect(h.calls.buildCallContext).toEqual([{ config: COMPACT_CONFIG, repoRoot: COMPACT_REPO_ROOT }]);
  });

  // AC-9
  test("closes the runtime once, after the op resolves", async () => {
    const h = makeCompactProjectHarness();

    await compactProjectMemory(h.input);

    expect(h.calls.closes).toBe(1);
    expect(h.calls.order).toEqual(["dispatch", "close"]);
  });

  // AC-10
  test("closes the runtime and rejects with the thrown error when the op throws", async () => {
    const h = makeCompactProjectHarness({ dispatchThrows: new Error("the model refused the call") });

    await expect(compactProjectMemory(h.input)).rejects.toThrow("the model refused the call");
    expect(h.calls.closes).toBe(1);
  });

  // AC-11
  test("answers unparseable, and touches neither confirm nor the host, when the reply is not a plan", async () => {
    const h = makeCompactProjectHarness({ plan: null });

    expect(await compactProjectMemory(h.input)).toEqual({ kind: "unparseable" });
    expect(h.calls.confirm).toEqual([]);
    expect(h.calls.apply).toEqual([]);
  });

  // AC-12
  test("answers invalid with every reason, and does not confirm, when a merge target is a taken slug", async () => {
    const h = makeCompactProjectHarness({
      candidates: COMPACT_CANDIDATES,
      projectNotes: [...COMPACT_CANDIDATES, COMPACT_PENDING_NOTE],
      plan: COLLIDING_PLAN,
    });

    expect(await compactProjectMemory(h.input)).toEqual({ kind: "invalid", reasons: COLLISION_REASONS });
    expect(h.calls.confirm).toEqual([]);
    expect(h.calls.apply).toEqual([]);
  });

  // AC-13
  test("answers dry-run with the preview, and touches neither confirm nor the host", async () => {
    const h = makeCompactProjectHarness({ dryRun: true });

    expect(await compactProjectMemory(h.input)).toEqual({ kind: "dry-run", preview: COMPACT_PREVIEW });
    expect(h.calls.confirm).toEqual([]);
    expect(h.calls.apply).toEqual([]);
  });

  // AC-14
  test("answers declined with the preview, and does not apply, when the person says no", async () => {
    const h = makeCompactProjectHarness({ confirmAnswer: false });

    expect(await compactProjectMemory(h.input)).toEqual({ kind: "declined", preview: COMPACT_PREVIEW });
    expect(h.calls.confirm).toEqual([COMPACT_PREVIEW]);
    expect(h.calls.apply).toEqual([]);
  });

  // AC-15
  test("counts notesAfter as notesBefore less the retired and merged-away notes plus the merged note", async () => {
    const h = makeCompactProjectHarness({ dryRun: true });

    const outcome = await compactProjectMemory(h.input);

    // Three notes: "alpha" retired, "beta" and "gamma" merged away, "beta-gamma" written.
    expect(outcome).toMatchObject({ preview: { notesBefore: 3, notesAfter: 1 } });
  });

  // AC-15
  test("counts a merge target that reuses its own source slug once, not twice", async () => {
    const h = makeCompactProjectHarness({ dryRun: true, plan: COMPACT_REUSE_PLAN });

    const outcome = await compactProjectMemory(h.input);

    // "gamma" is retired and rewritten under its own slug: the note stays, so only "beta" is lost.
    expect(outcome).toMatchObject({ preview: { notesBefore: 3, notesAfter: 2 } });
  });

  // AC-16
  test("applies once with the plan and the fill measured before it", async () => {
    const h = makeCompactProjectHarness();

    expect(await compactProjectMemory(h.input)).toEqual({
      kind: "applied",
      preview: COMPACT_PREVIEW,
      result: COMPACT_RESULT,
      fillAfter: 0.5,
    });
    expect(h.calls.apply).toEqual([{ plan: COMPACT_PLAN, model: "balanced", fillBefore: 0.5 }]);
  });

  // AC-17
  test("hands the apply the object form of the configured model as <agent>/<model>", async () => {
    const h = makeCompactProjectHarness({
      config: makeNaxConfig({
        memory: { indexBytes: 1000, compact: { model: { agent: "native", model: "openai/gpt-5" } } },
      }),
    });

    await compactProjectMemory(h.input);

    expect(h.calls.apply).toEqual([{ plan: COMPACT_PLAN, model: "native/openai/gpt-5", fillBefore: 0.5 }]);
  });

  // AC-18
  test("hands the apply the tier the config names, as written", async () => {
    const h = makeCompactProjectHarness({
      config: makeNaxConfig({ memory: { indexBytes: 1000, compact: { threshold: 0.65, model: "balanced" } } }),
    });

    await compactProjectMemory(h.input);

    expect(h.calls.apply).toEqual([{ plan: COMPACT_PLAN, model: "balanced", fillBefore: 0.5 }]);
  });

  // The default seam: the runtime comes from the config this call was handed, not from the disk.
  test("builds its CallContext around the config it was given, and closes the runtime it made", async () => {
    await withTempDir(async (repoRoot) => {
      const { ctx, close } = _compactProjectDeps.buildCallContext(COMPACT_CONFIG, repoRoot);
      try {
        expect(ctx.runtime.configLoader.current()).toBe(COMPACT_CONFIG);
        expect(ctx.packageDir).toBe(repoRoot);
        expect(ctx.agentName).toBe(ctx.runtime.agentManager.getDefault());
      } finally {
        await close();
      }
    });
  });
});
