/**
 * `guard.assess` — the rule-or-mean scorer behind the P5 flag-for-review guard.
 *
 * Every case below observes `assess` from the outside: the score, the basis
 * that produced it, the category it names, and how many times the shared
 * classifier was consulted. The fixtures live in `@test/helpers`
 * (`makeGuardFixture`) because US-004's runtime tests use the same ones.
 */
import { describe, expect, test } from "bun:test";
import {
  type GuardDecision,
  type ModelResult,
  type Observation,
  type QuestionId,
  RULE_SET_VERSION,
  type RuleResult,
} from "#src/command-safety/index";
import {
  assertDefined,
  GUARD_HIGH_ANSWER,
  GUARD_LOW_ANSWER,
  GUARD_THRESHOLD,
  makeGuardFixture,
} from "#test/helpers/index";

/** The policy root every AC passes as `cwd`. */
const ROOT = "/repo/proj";

/** The lower threshold AC21 uses, so a score of exactly 0.5 sits on the cut. */
const HALF_THRESHOLD = 0.5;

/** AC21's answer: harm none 0.5 / deletes_data 0.5, every noul P(yes) 0.5, so the score is exactly 0.5. */
const HALF_ANSWER: ModelResult = {
  status: "answered",
  latencyMs: 1,
  answers: {
    harm: {
      none: 0.5,
      deletes_data: 0.5,
      discards_work: 0,
      outside_project: 0,
      system_change: 0,
      network_send: 0,
      privilege: 0,
    },
    noul: {
      deletes_data: 0.5,
      discards_work: 0.5,
      outside_project: 0.5,
      system_change: 0.5,
      network_send: 0.5,
      privilege: 0.5,
    },
  },
};

describe("guard.assess", () => {
  test("AC9: high answer, no rule hit — flags on the model score with the top harm category", async () => {
    const { guard } = makeGuardFixture(GUARD_HIGH_ANSWER);

    const decision = await guard.assess({ command: "ls", cwd: ROOT, tempConfined: false });

    expect(decision.flagged).toBe(true);
    expect(decision.basis).toBe("model");
    expect(Math.abs(decision.score - 0.9)).toBeLessThan(1e-9);
    expect(decision.category).toBe("discards_work");
  });

  test("AC10: low answer, no rule hit — stays unflagged on the model basis", async () => {
    const { guard } = makeGuardFixture(GUARD_LOW_ANSWER);

    const decision = await guard.assess({ command: "ls", cwd: ROOT, tempConfined: false });

    expect(decision.flagged).toBe(false);
    expect(decision.basis).toBe("model");
    expect(Math.abs(decision.score - 0.055)).toBeLessThan(1e-9);
  });

  test("AC11: low answer but a rule hit — score 1, flagged, basis stays model", async () => {
    const { guard } = makeGuardFixture(GUARD_LOW_ANSWER);

    const decision = await guard.assess({ command: "git reset --hard", cwd: ROOT, tempConfined: false });

    expect(decision.flagged).toBe(true);
    expect(decision.score).toBe(1);
    expect(decision.basis).toBe("model");
    expect(decision.category).toBe("discards_work");
  });

  test("AC12: unavailable classifier with a rule hit — rules-only flag with the rule category", async () => {
    const { guard } = makeGuardFixture({ status: "unavailable", error: "timeout" });

    const decision = await guard.assess({ command: "git checkout src/a.ts", cwd: ROOT, tempConfined: false });

    expect(decision.flagged).toBe(true);
    expect(decision.basis).toBe("rules");
    expect(decision.category).toBe("discards_work");
  });

  test("AC13: unavailable classifier with no rule hit — not flagged, score 0, rules basis", async () => {
    const { guard } = makeGuardFixture({ status: "unavailable", error: "timeout" });

    const decision = await guard.assess({ command: "ls", cwd: ROOT, tempConfined: false });

    expect(decision.flagged).toBe(false);
    expect(decision.score).toBe(0);
    expect(decision.basis).toBe("rules");
    expect(decision.category).toBeUndefined();
  });

  test("AC14: an oversize result behaves like unavailable — rules-only, not flagged", async () => {
    const { guard } = makeGuardFixture({ status: "oversize", latencyMs: 1 });

    const decision = await guard.assess({ command: "ls", cwd: ROOT, tempConfined: false });

    expect(decision.flagged).toBe(false);
    expect(decision.score).toBe(0);
    expect(decision.basis).toBe("rules");
  });

  test("AC15: a blocked result scores 1 on the model basis, with no category key at all", async () => {
    const { guard } = makeGuardFixture({ status: "blocked", latencyMs: 1 });

    const decision = await guard.assess({ command: "ls", cwd: ROOT, tempConfined: false });

    expect(decision.flagged).toBe(true);
    expect(decision.score).toBe(1);
    expect(decision.basis).toBe("model");
    expect("category" in decision).toBe(false);
  });

  test("AC16: a synchronously throwing classifier resolves as rules-only, never rejects", async () => {
    const { guard } = makeGuardFixture("throws");

    const decision = await guard.assess({ command: "ls", cwd: ROOT, tempConfined: false });

    expect(decision.flagged).toBe(false);
    expect(decision.score).toBe(0);
    expect(decision.basis).toBe("rules");
  });

  test("AC17: a confined temp-only command skips the classifier entirely", async () => {
    const { guard, classifyCalls } = makeGuardFixture(GUARD_HIGH_ANSWER);

    const decision = await guard.assess({ command: "cp src/a.ts /tmp/a.bak", cwd: ROOT, tempConfined: true });

    expect(decision.flagged).toBe(false);
    expect(decision.score).toBe(0);
    expect(decision.basis).toBe("temp-only");
    expect(classifyCalls).toEqual([]);
  });

  test("AC18: a confined temp-only command that trips a rule still flags, naming that rule", async () => {
    const { guard } = makeGuardFixture(GUARD_LOW_ANSWER);

    const decision = await guard.assess({ command: "rm -rf /tmp/x", cwd: ROOT, tempConfined: true });

    expect(decision.flagged).toBe(true);
    expect(decision.score).toBe(1);
    expect(decision.basis).toBe("temp-only");
    expect(decision.category).toBe("deletes_data");
  });

  test("AC19: the same command not confined reaches the classifier exactly once", async () => {
    const { guard, classifyCalls } = makeGuardFixture(GUARD_HIGH_ANSWER);

    const decision = await guard.assess({ command: "cp src/a.ts /tmp/a.bak", cwd: ROOT, tempConfined: false });

    expect(decision.basis).toBe("model");
    expect(classifyCalls).toEqual(["cp src/a.ts /tmp/a.bak"]);
  });

  test("AC20: observe then assess classifies one command exactly once (shared cache)", async () => {
    const { shadow, guard, classifyCalls } = makeGuardFixture(GUARD_LOW_ANSWER);
    const obs: Observation = {
      command: "bun run test",
      identity: "Bash",
      stage: "run",
      mechanical: { verdict: "allow", breach: false },
    };

    shadow.observe("k1", obs);
    const decision = await guard.assess({ command: "bun run test", cwd: ROOT, tempConfined: false });

    expect(decision.basis).toBe("model");
    expect(classifyCalls).toEqual(["bun run test"]);
    await shadow.drain();
  });

  test("US-003 (AC17 counterpart): observe a temp-only command then assess it — classify runs once, basis stays temp-only", async () => {
    // The row opened by `observe` still classifies, but `assess` sees the
    // temp-only exemption and skips the classifier for its decision. The
    // shadow and the guard share one classifier promise per command, so
    // the count is exactly one and the basis is `temp-only` — not `model`.
    const { shadow, guard, classifyCalls } = makeGuardFixture(GUARD_HIGH_ANSWER);
    const obs: Observation = {
      command: "cp src/a.ts /tmp/a.bak",
      identity: "Bash",
      stage: "run",
      mechanical: { verdict: "allow", breach: false },
      cwd: ROOT,
    };

    shadow.observe("k1", obs);
    const decision = await guard.assess({ command: "cp src/a.ts /tmp/a.bak", cwd: ROOT, tempConfined: true });

    expect(classifyCalls).toEqual(["cp src/a.ts /tmp/a.bak"]);
    expect(decision.flagged).toBe(false);
    expect(decision.score).toBe(0);
    expect(decision.basis).toBe("temp-only");
    await shadow.drain();
  });

  test("AC21: a score exactly equal to the threshold flags", async () => {
    const { guard } = makeGuardFixture(HALF_ANSWER, { threshold: HALF_THRESHOLD });

    const decision = await guard.assess({ command: "ls", cwd: ROOT, tempConfined: false });

    expect(decision.flagged).toBe(true);
    expect(Math.abs(decision.score - HALF_THRESHOLD)).toBeLessThan(1e-9);
    expect(decision.threshold).toBe(HALF_THRESHOLD);
  });

  test("AC23: the category is the first hit in QUESTION_IDS order — discards_work before privilege", async () => {
    const { guard } = makeGuardFixture({ status: "unavailable", error: "timeout" });

    const decision = await guard.assess({ command: "sudo git reset --hard", cwd: ROOT, tempConfined: false });

    expect(decision.flagged).toBe(true);
    expect(decision.basis).toBe("rules");
    expect(decision.category).toBe("discards_work");
  });
});

/**
 * `scoreGuard` — the pure decision table `assess` composes, reaching the two
 * rules `assess` alone cannot express: that `outside_project` is skipped under
 * the temp-only exemption, and how a tied harm choice is broken.
 *
 * Loaded reflectively: a missing named export aborts the whole file at link
 * time (a `SyntaxError` before any test runs) instead of failing only the test
 * that needs it. The `expect` below is the pin on the export's existence.
 */
type ScoreGuard = (input: {
  readonly rules: RuleResult;
  readonly model: ModelResult | undefined;
  readonly tempOnly: boolean;
  readonly threshold: number;
}) => GuardDecision;

async function loadScoreGuard(): Promise<ScoreGuard> {
  const fn: ScoreGuard | undefined = Reflect.get(await import("#src/command-safety/index"), "scoreGuard");
  expect(typeof fn).toBe("function");
  assertDefined(fn, "scoreGuard export");
  return fn;
}

/** A `RuleResult` in which only the categories named in `hits` are true. */
function rulesWith(hits: Partial<Record<QuestionId, boolean>> = {}): RuleResult {
  return {
    version: RULE_SET_VERSION,
    hits: {
      deletes_data: false,
      discards_work: false,
      outside_project: false,
      system_change: false,
      network_send: false,
      privilege: false,
      ...hits,
    },
  };
}

/** A harm tie at the top: deletes_data and discards_work are both 0.45, so the score is (0.9 + 0.5) / 2. */
const TIE_ANSWER: ModelResult = {
  status: "answered",
  latencyMs: 1,
  answers: {
    harm: {
      none: 0.1,
      deletes_data: 0.45,
      discards_work: 0.45,
      outside_project: 0,
      system_change: 0,
      network_send: 0,
      privilege: 0,
    },
    noul: {
      deletes_data: 0.5,
      discards_work: 0.5,
      outside_project: 0.5,
      system_change: 0.5,
      network_send: 0.5,
      privilege: 0.5,
    },
  },
};

describe("scoreGuard", () => {
  test("US-003: under the temp-only exemption an outside_project hit alone scores 0", async () => {
    const scoreGuard = await loadScoreGuard();

    const decision = scoreGuard({
      rules: rulesWith({ outside_project: true }),
      model: undefined,
      tempOnly: true,
      threshold: GUARD_THRESHOLD,
    });

    expect(decision.flagged).toBe(false);
    expect(decision.score).toBe(0);
    expect(decision.basis).toBe("temp-only");
    expect(decision.threshold).toBe(GUARD_THRESHOLD);
  });

  test("US-003: a tied top harm option is broken by QUESTION_IDS order", async () => {
    const scoreGuard = await loadScoreGuard();

    const decision = scoreGuard({
      rules: rulesWith(),
      model: TIE_ANSWER,
      tempOnly: false,
      threshold: HALF_THRESHOLD,
    });

    expect(decision.flagged).toBe(true);
    expect(decision.basis).toBe("model");
    expect(Math.abs(decision.score - 0.7)).toBeLessThan(1e-9);
    expect(decision.category).toBe("deletes_data");
  });
});
