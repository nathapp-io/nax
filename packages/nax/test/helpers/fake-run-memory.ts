/**
 * The fake run memory three seams share (US-005 runtime, US-006 setup, US-007 workflow steps).
 *
 * Each of those seams only *carries* a `RunMemory` — the runtime holds it and closes it,
 * setup passes it along, a workflow step asks it for an index — so none of them reads its
 * host. The host here therefore refuses every read loudly: a seam that started reading one
 * fails the case rather than getting a value it could mistake for behaviour under test.
 *
 * The provider is the real id and the real run stage with no tools, and the reads (`index`)
 * and closes (`close`) are counted, because "how many times was the mirror touched" is what
 * those cases assert.
 *
 * ```ts
 * const fake = makeFakeRunMemory({ index: async () => "INDEX-LINE" });
 * expect(fake.memory.host).toBeDefined();
 * await fake.memory.close();
 * expect(fake.closes()).toBe(1);
 * ```
 */

import type { ToolProvider } from "@nathapp/nax-agent";
import type { MemoryHost, RunMemory } from "@/memory";

/** The provider a fake run memory hands over: the real id and the run stage, no tools. */
export const FAKE_MEMORY_PROVIDER: ToolProvider = {
  id: "nax-memory",
  kind: "static",
  stages: ["run"],
  tools: async () => [],
};

/**
 * A memory host that answers nothing.
 *
 * @param refusal - Why this seam must never read the host, in its own words
 */
export function makeFakeMemoryHost(refusal: string): MemoryHost {
  const unused = async (): Promise<never> => {
    throw new Error(refusal);
  };
  return {
    dirs: { root: "/mem", projectDir: "/mem/project", userDir: "/mem/user" },
    providerId: "local",
    writeMode: "direct",
    notes: unused,
    getNote: unused,
    search: unused,
    renderIndex: unused,
    sync: unused,
    status: unused,
    save: unused,
    forget: unused,
    approve: unused,
  };
}

/** A fake run memory plus the counts a case measures it by. */
export interface FakeRunMemory {
  readonly memory: RunMemory;
  /** How many times the seams asked for an index. */
  reads(): number;
  /** How many times something closed it. */
  closes(): number;
}

export interface FakeRunMemoryOptions {
  /** What `index()` answers; `undefined` by default. */
  readonly index?: () => Promise<string | undefined>;
  /**
   * The work a close does before it resolves — a case holds the close open with a
   * latch by awaiting a gate here.
   */
  readonly closing?: () => Promise<void>;
  /** Why the host refuses every read; each seam words it its own way. */
  readonly hostRefusal?: string;
}

/**
 * A run memory the runtime, setup and the workflow steps can carry.
 *
 * The read and close counts are taken before the caller's own work runs, so a case
 * measures the call rather than the body.
 *
 * @param opts - The index it answers and the work its close does
 */
export function makeFakeRunMemory(opts: FakeRunMemoryOptions = {}): FakeRunMemory {
  let reads = 0;
  let closes = 0;
  return {
    memory: {
      host: makeFakeMemoryHost(opts.hostRefusal ?? "this seam never reads a run memory's host"),
      provider: FAKE_MEMORY_PROVIDER,
      index: async () => {
        reads += 1;
        return await opts.index?.();
      },
      summary: () => ({ saved: 0, pending: 0 }),
      close: async () => {
        closes += 1;
        await opts.closing?.();
      },
    },
    reads: () => reads,
    closes: () => closes,
  };
}
