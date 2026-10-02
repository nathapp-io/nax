// nax's copy of nax-agent's test/helpers/command-safety.ts (S2-1 removed that export). Keep the two in step.
/**
 * Shared command-safety test fixtures for nax's wiring tests. The
 * `IDENTIFIER_KEYS` contract guard stays in nax-agent's copy only:
 * `CallIdentifiers` is not exported from either entry, and no nax test uses it.
 */
import { expect } from "bun:test";
import {
  type Classify,
  type CommandGuard,
  type CommandShadow,
  createCommandShadow,
  type FinalOutcome,
  type ModelResult,
  type Observation,
} from "@nathapp/nax-agent";
import { assertDefined } from "@nathapp/nax-test-kit/bun/assert-defined";

/** The single Observation a recorder captured, or a loud failure. */
export function observedOnly(r: { observed: [string, Observation][] }): Observation {
  expect(r.observed).toHaveLength(1);
  const entry = r.observed[0];
  if (entry === undefined) throw new Error("no observation was recorded");
  return entry[1];
}

/** A `CommandShadow` recording every `observe`/`settle` call, with overrides. */
export function makeCommandShadowRecorder(overrides: Partial<CommandShadow> = {}) {
  const observed: [string, Observation][] = [];
  const settled: [string, FinalOutcome][] = [];
  const shadow: CommandShadow = {
    observe: (k, o) => void observed.push([k, o]),
    settle: (k, o) => void settled.push([k, o]),
    drain: async () => {},
    ...overrides,
  };
  return { shadow, observed, settled };
}

// ─── the command-safety guard fixture ────────────────────────────────────────

/** The guard fixture's threshold: the schema default, and the spec's fixture value. */
export const GUARD_THRESHOLD = 0.75;

/**
 * The spec's "high" answer: the harm choice gives `none` 0.1, `discards_work`
 * 0.6 and each of the other five categories 0.06, and every noul `P(yes)` is
 * 0.9. Its score is `((1 - 0.1) + 0.9) / 2 = 0.9`.
 */
export const GUARD_HIGH_ANSWER: ModelResult = {
  status: "answered",
  latencyMs: 7,
  answers: {
    harm: {
      none: 0.1,
      deletes_data: 0.06,
      discards_work: 0.6,
      outside_project: 0.06,
      system_change: 0.06,
      network_send: 0.06,
      privilege: 0.06,
    },
    noul: {
      deletes_data: 0.9,
      discards_work: 0.9,
      outside_project: 0.9,
      system_change: 0.9,
      network_send: 0.9,
      privilege: 0.9,
    },
  },
};

/**
 * The spec's "low" answer: the harm choice gives `none` 0.94 and each of the
 * six categories 0.01, and every noul `P(yes)` is 0.05. Its score is
 * `(0.06 + 0.05) / 2 = 0.055`.
 */
export const GUARD_LOW_ANSWER: ModelResult = {
  status: "answered",
  latencyMs: 7,
  answers: {
    harm: {
      none: 0.94,
      deletes_data: 0.01,
      discards_work: 0.01,
      outside_project: 0.01,
      system_change: 0.01,
      network_send: 0.01,
      privilege: 0.01,
    },
    noul: {
      deletes_data: 0.05,
      discards_work: 0.05,
      outside_project: 0.05,
      system_change: 0.05,
      network_send: 0.05,
      privilege: 0.05,
    },
  },
};

/** What the fixture's stub classifier answers with: a result, or a synchronous throw. */
export type GuardClassifyAnswer = ModelResult | "throws";

export interface GuardFixtureOptions {
  /** Guard threshold. Defaults to `GUARD_THRESHOLD` (0.75). */
  readonly threshold?: number;
}

export interface GuardFixture {
  /** The shadow the guard was created with — `observe`/`settle`/`drain` are real. */
  readonly shadow: CommandShadow;
  /** The shadow's guard, asserted present. */
  readonly guard: CommandGuard;
  /** Every command the stub classifier received, in order. */
  readonly classifyCalls: string[];
}

/**
 * The spec's guard fixture: `createCommandShadow` with a recording classifier
 * stub, a no-op write, `runId` `"r1"`, `timeoutMs` 1000 and a `guard` block.
 *
 * Shared because US-004's runtime tests use the same fixture; the stub never
 * touches the network or the disk.
 */
export function makeGuardFixture(
  answer: GuardClassifyAnswer = GUARD_HIGH_ANSWER,
  opts: GuardFixtureOptions = {},
): GuardFixture {
  const classifyCalls: string[] = [];
  const classify: Classify = (command) => {
    classifyCalls.push(command);
    if (answer === "throws") throw new Error("classify threw synchronously");
    return Promise.resolve(answer);
  };
  const shadow = createCommandShadow({
    classify,
    write: async () => {},
    runId: "r1",
    timeoutMs: 1000,
    guard: { threshold: opts.threshold ?? GUARD_THRESHOLD },
  });
  return { shadow, guard: requireGuard(shadow), classifyCalls };
}

/**
 * The shadow's guard, or a loud failure.
 *
 * `expect` comes first so a missing guard fails as an unmet assertion rather
 * than a `TypeError` on `undefined.assess`; `assertDefined` then narrows the
 * value for the caller, which `expect` cannot do.
 */
export function requireGuard(shadow: CommandShadow): CommandGuard {
  const guard = shadow.guard;
  expect(guard).toBeDefined();
  assertDefined(guard, "shadow.guard (createCommandShadow was given the guard option)");
  return guard;
}
