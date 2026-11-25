/**
 * The harness `compactProjectMemory`'s two test files share (US-014).
 *
 * The orchestration is one flow with five sides — the host, the facts read, the
 * call context, the op dispatch and the person's answer — and every case drives a
 * subset of them. Composing that here, once, is what keeps a case down to the
 * three lines that say what it is about (`docs/guides/testing-rules.md` § mocks).
 *
 * What the harness does NOT do is decide an outcome: the host's candidates, notes
 * and indexes and the op's reply are all options, so the same fixture answers
 * "no candidates", "a plan that collides", "the person declined" and "applied"
 * without any case rebuilding it.
 *
 * Two numbers are deliberate. The index is a single line of 500 bytes under a
 * 1000-byte cap, so the fill every case reads is exactly 0.5 (`memoryIndexFill`
 * takes the larger of the byte and line ratios; one line is 1/200). And the
 * threshold is 0.65, which is not the schema's 0.8, so a case that asserts the
 * target percentage is 65 proves it was read rather than defaulted.
 */
import type { MemoryNote, RenderedMemoryIndex } from "@nathapp/nax-agent";
import type { MemoryCompactionPlan, MemoryCompactionResult } from "@nathapp/nax-agent/internal";
import type { NaxConfig } from "@/config";
import {
  _compactProjectDeps,
  type CompactProjectMemoryInput,
  type MemoryCompactFacts,
  type MemoryCompactPreview,
  type MemoryHost,
} from "@/memory";
import { makeMockCallContext } from "./call-context";
import { makeScriptedCallOp } from "./call-op";
import { makeFakeMemoryHost } from "./fake-run-memory";
import { makeNaxConfig } from "./mock-nax-config";

/** The repository root every case hands over; nothing in the harness reads the disk. */
export const COMPACT_REPO_ROOT = "/repo/nax-compact";

/** One project note, active and of the type a compaction may act on. */
export function compactNote(slug: string, overrides: Partial<MemoryNote> = {}): MemoryNote {
  return {
    id: slug,
    slug,
    type: "project",
    scope: "project",
    description: `about ${slug}`,
    source: "nax-run",
    updatedAt: "2026-11-25T08:00:00Z",
    status: "active",
    body: `body of ${slug}`,
    ...overrides,
  };
}

/** The notes a plan may act on: three of them, so one can be retired and two merged. */
export const COMPACT_CANDIDATES: readonly MemoryNote[] = [
  compactNote("alpha"),
  compactNote("beta"),
  compactNote("gamma"),
];

/** A note the mirror holds that is not a candidate: a pending one a merge may not take the slug of. */
export const COMPACT_PENDING_NOTE = compactNote("delta", { status: "pending" });

/** The fact lists a dispatch carries; each is distinguishable from an empty default. */
export const COMPACT_FACTS: MemoryCompactFacts = {
  features: [{ name: "memory-compaction", passed: 12, total: 20 }],
  branches: ["main", "feat/memory-compaction"],
  commits: ["feat: add the compaction prompt", "fix: read the facts"],
};

/** A valid plan against {@link COMPACT_CANDIDATES}: retire one note, fold two into a new slug. */
export const COMPACT_PLAN: MemoryCompactionPlan = {
  retire: [{ slug: "alpha", reason: "the budget decision it recorded has shipped" }],
  merge: [
    {
      from: ["beta", "gamma"],
      into: { slug: "beta-gamma", type: "project", description: "beta and gamma, together", body: "merged body" },
    },
  ],
};

/** A merge that keeps one of its own source slugs: the case a note count must not double-count. */
export const COMPACT_REUSE_PLAN: MemoryCompactionPlan = {
  retire: [],
  merge: [
    {
      from: ["beta", "gamma"],
      into: { slug: "gamma", type: "project", description: "gamma, folded", body: "folded body" },
    },
  ],
};

/** What a stubbed apply answers. */
export const COMPACT_RESULT: MemoryCompactionResult = {
  id: "20261125T101500Z-3fa2c1",
  retired: ["alpha"],
  merged: [{ from: ["beta", "gamma"], into: "beta-gamma" }],
  notesBefore: 3,
  notesAfter: 1,
};

/** The preview {@link COMPACT_PLAN} projects: three notes before, one after. */
export const COMPACT_PREVIEW: MemoryCompactPreview = {
  plan: COMPACT_PLAN,
  fillBefore: 0.5,
  notesBefore: 3,
  notesAfter: 1,
};

/** The index before an apply: 500 bytes under the config's 1000-byte cap, so the fill is 0.5. */
export const COMPACT_INDEX: RenderedMemoryIndex = { text: "x".repeat(500), omitted: 0 };

/** The index after one: 20 bytes, so the fill is 0.02. */
export const COMPACT_INDEX_AFTER: RenderedMemoryIndex = { text: "x".repeat(20), omitted: 0 };

/** The config every case starts from: a 1000-byte cap, a 65% threshold and the default model tier. */
export const COMPACT_CONFIG: NaxConfig = makeNaxConfig({
  memory: { indexBytes: 1000, compact: { threshold: 0.65, model: "balanced" } },
});

/** What one host's `applyCompaction` is given. */
export type CompactApplyInput = Parameters<NonNullable<MemoryHost["applyCompaction"]>>[0];

/** Everything a case measures: the seams it reached, and in which order. */
export interface CompactProjectCalls {
  readonly readFacts: string[];
  readonly buildCallContext: Array<{ readonly config: NaxConfig; readonly repoRoot: string }>;
  readonly dispatch: Array<{ readonly op: { readonly name: string; readonly kind: string }; readonly input: unknown }>;
  readonly confirm: MemoryCompactPreview[];
  readonly apply: CompactApplyInput[];
  readonly order: string[];
  renders: number;
  closes: number;
}

/** What a case needs to assert on: the input it hands over, the seams, and the host behind them. */
export interface CompactProjectHarness {
  readonly input: CompactProjectMemoryInput;
  readonly calls: CompactProjectCalls;
  readonly host: MemoryHost;
}

/** What a case may vary. Absent means the harness's own default, never a different shape. */
export interface CompactProjectOptions {
  readonly config?: NaxConfig;
  /** The notes the plan may act on. */
  readonly candidates?: readonly MemoryNote[];
  /** Every project note the mirror holds, candidates and the rest. */
  readonly projectNotes?: readonly MemoryNote[];
  readonly index?: RenderedMemoryIndex;
  /** What the index answers once an apply has run. */
  readonly indexAfterApply?: RenderedMemoryIndex;
  /** `false` composes a host with no `compactionCandidates` member at all. */
  readonly capabilities?: boolean;
  readonly writeMode?: "direct" | "proposal";
  /** What the op answers; `undefined` means {@link COMPACT_PLAN}, `null` an unusable reply. */
  readonly plan?: MemoryCompactionPlan | null;
  /** When set, the dispatch rejects with it instead of answering a plan. */
  readonly dispatchThrows?: Error;
  readonly dryRun?: boolean;
  /** What the person answers; `true` by default. */
  readonly confirmAnswer?: boolean;
}

/** Every counter at zero, so a case reads only what its own call did. */
function emptyCalls(): CompactProjectCalls {
  return {
    readFacts: [],
    buildCallContext: [],
    dispatch: [],
    confirm: [],
    apply: [],
    order: [],
    renders: 0,
    closes: 0,
  };
}

/** The host under test: what a case varies, over a host whose other members refuse to be read. */
function compactionHost(
  options: CompactProjectOptions,
  calls: CompactProjectCalls,
  applied: () => boolean,
  markApplied: () => void,
): MemoryHost {
  const base = makeFakeMemoryHost("compaction reads only its candidates, the project notes and the index");
  const candidates = { compactionCandidates: async () => options.candidates ?? COMPACT_CANDIDATES };
  return {
    ...base,
    writeMode: options.writeMode ?? base.writeMode,
    ...((options.capabilities ?? true) ? candidates : {}),
    notes: async () => options.projectNotes ?? COMPACT_CANDIDATES,
    renderIndex: async () => {
      calls.renders += 1;
      if (!applied()) return options.index ?? COMPACT_INDEX;
      return options.indexAfterApply ?? options.index ?? COMPACT_INDEX;
    },
    applyCompaction: async (applyInput) => {
      markApplied();
      calls.apply.push(applyInput);
      return COMPACT_RESULT;
    },
  };
}

/**
 * Install the three seams over the real flow. The facts read and the call-context
 * builder are recorded rather than performed — a real runtime boots under them,
 * and no case here is about booting one. The dispatch answers the case's plan
 * through `makeScriptedCallOp`, so the op it receives is the real one.
 */
function stubDeps(options: CompactProjectOptions, calls: CompactProjectCalls): void {
  _compactProjectDeps.readFacts = async (repoRoot) => {
    calls.readFacts.push(repoRoot);
    return COMPACT_FACTS;
  };
  _compactProjectDeps.buildCallContext = (config, repoRoot) => {
    calls.buildCallContext.push({ config, repoRoot });
    return {
      ctx: makeMockCallContext(),
      close: async () => {
        calls.order.push("close");
        calls.closes += 1;
      },
    };
  };
  _compactProjectDeps.callOp = makeScriptedCallOp((op, input) => {
    calls.order.push("dispatch");
    calls.dispatch.push({ op, input });
    if (options.dispatchThrows) throw options.dispatchThrows;
    return options.plan === undefined ? COMPACT_PLAN : options.plan;
  });
}

/**
 * Compose one compaction's worth of fixtures.
 *
 * @param options - What the case varies; everything else is the harness default
 */
export function makeCompactProjectHarness(options: CompactProjectOptions = {}): CompactProjectHarness {
  const config = options.config ?? COMPACT_CONFIG;
  const calls = emptyCalls();
  let applied = false;
  const host = compactionHost(
    options,
    calls,
    () => applied,
    () => {
      applied = true;
    },
  );
  stubDeps(options, calls);
  return {
    calls,
    host,
    input: {
      config,
      repoRoot: COMPACT_REPO_ROOT,
      host,
      dryRun: options.dryRun ?? false,
      confirm: async (preview) => {
        calls.confirm.push(preview);
        return options.confirmAnswer ?? true;
      },
    },
  };
}
