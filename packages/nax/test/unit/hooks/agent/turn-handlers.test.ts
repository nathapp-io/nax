/**
 * US-005 — the agent-hook loop handlers for the turn events.
 *
 * `SessionStart` and `UserPromptSubmit` share the `before_turn` handler (start
 * first, then the prompt, in one handler because `dispatchChain` merges by
 * overwrite), and `Stop` is the `before_turn_end` handler. Every test drives the
 * set the way the native loop does, through the shared `callBeforeTurn` /
 * `callBeforeTurnEnd` helpers, and stubs
 * `_agentHookHandlerDeps.runAgentHook`: assertions are made on the `entry`,
 * `payload` and `cwd` the handler would have handed a real hook, and on the
 * patch the loop would have received.
 *
 * The AC id is the test-name prefix.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  beforeTurnEndPayload,
  beforeTurnPayload,
  callBeforeTurn,
  callBeforeTurnEnd,
  handlerContext,
  withWarnSpy,
} from "@test/helpers";
import {
  _agentHookHandlerDeps,
  AGENT_HOOKS_PLUGIN,
  type AgentHookEntry,
  type AgentHookRun,
  type AgentHooksConfig,
  createAgentHookHandlers,
} from "@/hooks";

// ─────────────────────────────────────────────────────────────────────────────
// Injecting the runner
// ─────────────────────────────────────────────────────────────────────────────

/** One call the handlers made into `runAgentHook`. */
type CapturedRun = Parameters<typeof _agentHookHandlerDeps.runAgentHook>[0];

let runs: CapturedRun[] = [];
let answers: AgentHookRun[] = [];
const realRunAgentHook = _agentHookHandlerDeps.runAgentHook;

beforeEach(() => {
  runs = [];
  answers = [];
  _agentHookHandlerDeps.runAgentHook = async (input) => {
    runs.push(input);
    return answers[runs.length - 1] ?? { kind: "ok", stdout: "" };
  };
});

afterEach(() => {
  _agentHookHandlerDeps.runAgentHook = realRunAgentHook;
});

/** The answers the next dispatch consumes, and a fresh `runs` to assert on. */
function answerNext(next: readonly AgentHookRun[] = []): void {
  runs = [];
  answers = [...next];
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

/** One configured hook entry, defaulted to a both-surfaces project entry. */
function hook(overrides: Partial<AgentHookEntry> & { command: string }): AgentHookEntry {
  return { scope: ["chat", "run"], timeoutMs: 30_000, origin: "project", ...overrides };
}

/**
 * A config with every event present and empty except the ones given.
 *
 * The five keys are spelled out rather than looped over `AGENT_HOOK_EVENTS`: a loop
 * cannot build the always-complete mapped type without a cast, and this literal fails
 * to compile the moment an event is added — which a cast would hide.
 */
function hooksConfig(input: Partial<AgentHooksConfig> = {}): AgentHooksConfig {
  return {
    PreToolUse: input.PreToolUse ?? [],
    PostToolUse: input.PostToolUse ?? [],
    UserPromptSubmit: input.UserPromptSubmit ?? [],
    SessionStart: input.SessionStart ?? [],
    Stop: input.Stop ?? [],
  };
}

const REPO_ROOT = "/repo";

function buildSet(config: AgentHooksConfig, surface: "chat" | "run" = "run") {
  return createAgentHookHandlers({ config, surface, repoRoot: REPO_ROOT });
}

/** Every entry of one turn event in a set (there is at most one by design). */
function entriesFor(set: ReturnType<typeof buildSet>, event: "before_turn" | "before_turn_end") {
  return set.filter((entry) => entry.event === event);
}

// ─────────────────────────────────────────────────────────────────────────────
// Construction: one handler per event, with its deadline
// ─────────────────────────────────────────────────────────────────────────────

describe("createAgentHookHandlers — the turn events", () => {
  test("AC-1: SessionStart and UserPromptSubmit share ONE before_turn entry whose deadline covers both", () => {
    const config = hooksConfig({
      SessionStart: [hook({ command: "start.sh", timeoutMs: 1000 })],
      UserPromptSubmit: [hook({ command: "guard.sh", timeoutMs: 2000 })],
    });

    const beforeTurn = entriesFor(buildSet(config, "chat"), "before_turn");

    expect(beforeTurn).toHaveLength(1);
    expect(beforeTurn[0].plugin).toBe(AGENT_HOOKS_PLUGIN);
    // 1000 + (1000 + 7000) + (2000 + 7000)
    expect(beforeTurn[0].timeoutMs).toBe(18_000);
  });

  test("AC-2: one Stop entry becomes one before_turn_end entry with its deadline", () => {
    const config = hooksConfig({ Stop: [hook({ command: "keep-going.sh", timeoutMs: 3000 })] });

    const beforeTurnEnd = entriesFor(buildSet(config, "run"), "before_turn_end");

    expect(beforeTurnEnd).toHaveLength(1);
    expect(beforeTurnEnd[0].plugin).toBe(AGENT_HOOKS_PLUGIN);
    // 1000 + (3000 + 5000 + 2000)
    expect(beforeTurnEnd[0].timeoutMs).toBe(11_000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// before_turn: which entries run, and in what order
// ─────────────────────────────────────────────────────────────────────────────

/** A set with one SessionStart and one UserPromptSubmit entry, in config order. */
function turnSet(surface: "chat" | "run" = "run") {
  return buildSet(
    hooksConfig({
      SessionStart: [hook({ command: "start.sh" })],
      UserPromptSubmit: [hook({ command: "guard.sh" })],
    }),
    surface,
  );
}

describe("before_turn — the entries a turn runs", () => {
  test("AC-3: an empty history runs SessionStart, then UserPromptSubmit with the prompt", async () => {
    const set = turnSet();

    answerNext([
      { kind: "ok", stdout: "" },
      { kind: "ok", stdout: "" },
    ]);
    await callBeforeTurn(set, beforeTurnPayload({ prompt: "fix the bug" }), handlerContext());

    expect(runs).toHaveLength(2);
    expect(runs[0].entry.command).toBe("start.sh");
    expect(runs[0].payload.hook_event_name).toBe("SessionStart");
    expect(runs[0].payload.prompt).toBeUndefined();
    expect(runs[1].entry.command).toBe("guard.sh");
    expect(runs[1].payload.hook_event_name).toBe("UserPromptSubmit");
    expect(runs[1].payload.prompt).toBe("fix the bug");
  });

  test("AC-4: a turn with loaded history runs no SessionStart entry", async () => {
    const set = turnSet();

    answerNext([{ kind: "ok", stdout: "" }]);
    await callBeforeTurn(
      set,
      beforeTurnPayload({ prompt: "and now?", history: [{ role: "user", content: "earlier" }] }),
      handlerContext(),
    );

    expect(runs).toHaveLength(1);
    expect(runs[0].entry.command).toBe("guard.sh");
    expect(runs[0].payload.hook_event_name).toBe("UserPromptSubmit");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// before_turn: blocking the prompt, and a hook that fails
// ─────────────────────────────────────────────────────────────────────────────

/** A set with two UserPromptSubmit entries, so "the rest did not run" is visible. */
function guardSet(surface: "chat" | "run" = "run") {
  return buildSet(
    hooksConfig({
      UserPromptSubmit: [hook({ command: "guard.sh" }), hook({ command: "later.sh" })],
    }),
    surface,
  );
}

describe("before_turn — an answer that refuses the prompt", () => {
  test("AC-8: a block run refuses the prompt with its reason, and the remaining entries do not run", async () => {
    const set = guardSet();

    answerNext([{ kind: "block", reason: "contains a key" }]);
    const patch = await callBeforeTurn(set, beforeTurnPayload({ prompt: "sk-secret" }), handlerContext());

    expect(patch).toEqual({ block: { reason: "contains a key" } });
    expect(runs).toHaveLength(1);
    expect(runs[0].entry.command).toBe("guard.sh");
  });

  test('AC-9: a JSON decision "block" refuses the prompt with its reason', async () => {
    const set = guardSet();

    answerNext([{ kind: "ok", stdout: "", json: { decision: "block", reason: "r" } }]);
    const patch = await callBeforeTurn(set, beforeTurnPayload({ prompt: "anything" }), handlerContext());

    expect(patch).toEqual({ block: { reason: "r" } });
  });

  test('block: a decision "block" without a reason names the hook', async () => {
    const set = guardSet();

    answerNext([{ kind: "ok", stdout: "", json: { decision: "block" } }]);
    const patch = await callBeforeTurn(set, beforeTurnPayload({ prompt: "anything" }), handlerContext());

    expect(patch).toEqual({ block: { reason: "blocked by hook 'guard.sh'" } });
  });

  test("block: a refusal discards the context earlier entries had added", async () => {
    const set = buildSet(
      hooksConfig({
        SessionStart: [hook({ command: "start.sh" })],
        UserPromptSubmit: [hook({ command: "guard.sh" })],
      }),
    );

    answerNext([
      { kind: "ok", stdout: "repo: nax" },
      { kind: "block", reason: "no" },
    ]);
    const patch = await callBeforeTurn(set, beforeTurnPayload({ prompt: "anything" }), handlerContext());

    expect(patch).toEqual({ block: { reason: "no" } });
  });
});

describe("before_turn — a hook that fails", () => {
  test("AC-10: on chat a failed UserPromptSubmit hook refuses the prompt, naming the hook", async () => {
    const set = guardSet("chat");

    answerNext([{ kind: "error", reason: "exited 3" }]);
    const patch = await callBeforeTurn(set, beforeTurnPayload({ prompt: "hello" }), handlerContext());

    const reason = patch?.block?.reason ?? "";
    expect(reason).toContain("guard.sh");
    expect(reason).toContain("exited 3");
    // Fail closed: the entries after a broken guard are not run.
    expect(runs).toHaveLength(1);
  });

  test("AC-11: on run a failed UserPromptSubmit hook is let through with one warning", async () => {
    const set = guardSet("run");

    await withWarnSpy(async (spy) => {
      answerNext([
        { kind: "error", reason: "exited 3" },
        { kind: "ok", stdout: "" },
      ]);
      const patch = await callBeforeTurn(set, beforeTurnPayload({ prompt: "hello" }), handlerContext());

      expect(patch).toBeUndefined();
      expect(runs.map((run) => run.entry.command)).toEqual(["guard.sh", "later.sh"]);

      const warnings = spy.mock.calls.filter((call) => call[0] === "agent-hooks");
      expect(warnings).toHaveLength(1);
      expect(warnings[0][1]).toContain("guard.sh");
    });
  });

  test.each([
    ["block", { kind: "block" as const, reason: "not now" }],
    ["error", { kind: "error" as const, reason: "exited 3" }],
  ])("AC-12: a SessionStart %s run adds nothing and warns once", async (_kind, run) => {
    const set = buildSet(hooksConfig({ SessionStart: [hook({ command: "start.sh" })] }));

    await withWarnSpy(async (spy) => {
      answerNext([run]);
      const patch = await callBeforeTurn(set, beforeTurnPayload({ prompt: "first turn" }), handlerContext());

      expect(patch).toBeUndefined();

      const warnings = spy.mock.calls.filter((call) => call[0] === "agent-hooks");
      expect(warnings).toHaveLength(1);
      expect(warnings[0][1]).toContain("start.sh");
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// before_turn: the context the turn's prompt is given
// ─────────────────────────────────────────────────────────────────────────────

describe("before_turn — context", () => {
  test("AC-5: SessionStart plain text and UserPromptSubmit additionalContext are joined in order", async () => {
    const set = turnSet();

    answerNext([
      { kind: "ok", stdout: "repo: nax" },
      { kind: "ok", stdout: "", json: { additionalContext: "be brief" } },
    ]);
    const patch = await callBeforeTurn(set, beforeTurnPayload({ prompt: "fix it" }), handlerContext());

    expect(patch).toEqual({ promptContext: "repo: nax\n\nbe brief" });
  });

  test("AC-6: a UserPromptSubmit hook's plain-text stdout is context", async () => {
    const set = buildSet(hooksConfig({ UserPromptSubmit: [hook({ command: "date.sh" })] }));

    answerNext([{ kind: "ok", stdout: "today is monday" }]);
    const patch = await callBeforeTurn(set, beforeTurnPayload({ prompt: "what day is it?" }), handlerContext());

    expect(patch).toEqual({ promptContext: "today is monday" });
  });

  test("AC-7: a JSON object is never plain text, and empty answers add nothing", async () => {
    const set = turnSet();

    answerNext([
      { kind: "ok", stdout: "{}", json: {} },
      { kind: "ok", stdout: "" },
    ]);
    const patch = await callBeforeTurn(set, beforeTurnPayload({ prompt: "anything" }), handlerContext());

    expect(patch).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// before_turn_end: Stop
// ─────────────────────────────────────────────────────────────────────────────

/** A set with two Stop entries, so "the rest did not run" is visible. */
function stopSet() {
  return buildSet(
    hooksConfig({
      Stop: [hook({ command: "tests-green.sh" }), hook({ command: "later.sh" })],
    }),
  );
}

describe("before_turn_end — the Stop payload", () => {
  test("AC-13: a turn that completed on its own runs Stop with stop_hook_active false", async () => {
    const set = stopSet();
    const ctx = handlerContext({ sessionName: "sess-stop" });

    answerNext([
      { kind: "ok", stdout: "" },
      { kind: "ok", stdout: "" },
    ]);
    await callBeforeTurnEnd(set, beforeTurnEndPayload(), ctx);

    expect(runs).toHaveLength(2);
    expect(runs[0].cwd).toBe(REPO_ROOT);
    expect(runs[0].payload).toMatchObject({
      hook_event_name: "Stop",
      session_id: "sess-stop",
      surface: "run",
      cwd: REPO_ROOT,
      stop_hook_active: false,
    });
  });

  test("AC-14: from the second Stop run of a turn on, stop_hook_active is true", async () => {
    const set = stopSet();

    answerNext();
    await callBeforeTurnEnd(set, beforeTurnEndPayload({ followUpsSoFar: 1 }), handlerContext());

    expect(runs[0].payload.stop_hook_active).toBe(true);
  });
});

describe("before_turn_end — an answer that continues the turn", () => {
  test("AC-15: a block run continues the turn with its reason, and the remaining entries do not run", async () => {
    const set = stopSet();

    answerNext([{ kind: "block", reason: "tests still fail" }]);
    const patch = await callBeforeTurnEnd(set, beforeTurnEndPayload(), handlerContext());

    expect(patch).toEqual({ followUp: "tests still fail" });
    expect(runs).toHaveLength(1);
    expect(runs[0].entry.command).toBe("tests-green.sh");
  });

  test('AC-16: a JSON decision "block" continues the turn with its reason', async () => {
    const set = stopSet();

    answerNext([{ kind: "ok", stdout: "", json: { decision: "block", reason: "go on" } }]);
    const patch = await callBeforeTurnEnd(set, beforeTurnEndPayload(), handlerContext());

    expect(patch).toEqual({ followUp: "go on" });
  });

  test("AC-17: a quiet success ends the turn", async () => {
    const set = stopSet();

    answerNext([
      { kind: "ok", stdout: "" },
      { kind: "ok", stdout: "" },
    ]);
    const patch = await callBeforeTurnEnd(set, beforeTurnEndPayload(), handlerContext());

    expect(patch).toBeUndefined();
    expect(runs).toHaveLength(2);
  });

  test("stop: plain-text stdout is not a reason to continue, and a decision without one names the hook", async () => {
    const set = buildSet(hooksConfig({ Stop: [hook({ command: "tests-green.sh" })] }));

    answerNext([{ kind: "ok", stdout: "all good" }]);
    expect(await callBeforeTurnEnd(set, beforeTurnEndPayload(), handlerContext())).toBeUndefined();

    answerNext([{ kind: "ok", stdout: "", json: { decision: "block" } }]);
    expect(await callBeforeTurnEnd(set, beforeTurnEndPayload(), handlerContext())).toEqual({
      followUp: "blocked by hook 'tests-green.sh'",
    });
  });

  test("AC-18: a failed Stop hook ends the turn and warns once, naming the hook", async () => {
    const set = stopSet();

    await withWarnSpy(async (spy) => {
      answerNext([
        { kind: "error", reason: "exited 1" },
        { kind: "ok", stdout: "" },
      ]);
      const patch = await callBeforeTurnEnd(set, beforeTurnEndPayload(), handlerContext());

      expect(patch).toBeUndefined();
      // A failure in one entry does not stop the next from answering.
      expect(runs.map((run) => run.entry.command)).toEqual(["tests-green.sh", "later.sh"]);

      const warnings = spy.mock.calls.filter((call) => call[0] === "agent-hooks");
      expect(warnings).toHaveLength(1);
      expect(warnings[0][1]).toContain("tests-green.sh");
    });
  });
});

describe("before_turn_end — turns Stop must not see", () => {
  test.each([
    ["aborted", { ended: "aborted" as const }],
    ["errored", { ended: "errored" as const }],
    ["completed by a stop", { ended: "completed" as const, stopped: true }],
  ])("AC-19: no Stop entry runs for a turn that %s", async (_label, input) => {
    const set = stopSet();

    answerNext();
    const patch = await callBeforeTurnEnd(set, beforeTurnEndPayload(input), handlerContext());

    expect(patch).toBeUndefined();
    expect(runs).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The payload every turn event hands over
// ─────────────────────────────────────────────────────────────────────────────

describe("before_turn — the payload", () => {
  test("payload: carries the event, session, surface, cwd and the context's facts", async () => {
    const set = turnSet("run");
    const ctx = handlerContext({
      sessionName: "sess-turn-payload",
      role: "wf-implementer",
      feature: "agent-hooks",
      storyId: "US-005",
      model: "claude-sonnet-4",
    });

    answerNext();
    await callBeforeTurn(set, beforeTurnPayload({ prompt: "hello" }), ctx);

    expect(runs[1].cwd).toBe(REPO_ROOT);
    expect(runs[1].payload).toMatchObject({
      hook_event_name: "UserPromptSubmit",
      session_id: "sess-turn-payload",
      surface: "run",
      cwd: REPO_ROOT,
      prompt: "hello",
      role: "wf-implementer",
      feature: "agent-hooks",
      story_id: "US-005",
      model: "claude-sonnet-4",
    });
  });

  test("payload: cwd is the context's workdir when present, else the factory's repoRoot", async () => {
    const set = turnSet();

    answerNext();
    await callBeforeTurn(set, beforeTurnPayload({ prompt: "hello" }), handlerContext({ workdir: "/work/tree" }));
    expect(runs[1].cwd).toBe("/work/tree");
    expect(runs[1].payload.cwd).toBe("/work/tree");

    answerNext();
    await callBeforeTurn(set, beforeTurnPayload({ prompt: "hello" }), handlerContext());
    expect(runs[1].cwd).toBe(REPO_ROOT);
  });
});
