/**
 * US-004 — the agent-hook loop handlers for the two tool events.
 *
 * `createAgentHookHandlers` turns the `agent` section of `hooks.json` into a
 * `LoopHandlerSet` for ONE surface: scope filtering happens once at
 * construction, at most one entry is registered per loop event, and that entry
 * runs every applicable hook entry in config order. One entry per event is not
 * cosmetic — `dispatchChain` merges a patch chain by overwrite, so two
 * `before_turn` handlers would keep only the last one's answer.
 *
 * Every test drives the set the way the native loop does, through the shared
 * `callBeforeTool` / `callAfterTool` helpers, and stubs
 * `_agentHookHandlerDeps.runAgentHook`: assertions are made on the `entry`,
 * `payload` and `cwd` the handler would have handed a real hook, and on the
 * patch the loop would have received.
 *
 * The AC id is the test-name prefix.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  afterToolPayload,
  beforeToolPayload,
  callAfterTool,
  callBeforeTool,
  handlerContext,
  loopHandlerEntry,
  outcomeText,
  withWarnSpy,
} from "@test/helpers";
import {
  _agentHookHandlerDeps,
  AGENT_HOOK_EVENTS,
  AGENT_HOOK_MAX_RECORDED_CALLS,
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

/** A config with every event present and empty except the ones given. */
function hooksConfig(input: Partial<Record<(typeof AGENT_HOOK_EVENTS)[number], readonly AgentHookEntry[]>> = {}) {
  const config: Record<string, readonly AgentHookEntry[]> = {};
  for (const event of AGENT_HOOK_EVENTS) config[event] = input[event] ?? [];
  return config as AgentHooksConfig;
}

const REPO_ROOT = "/repo";

function buildSet(config: AgentHooksConfig, surface: "chat" | "run" = "run") {
  return createAgentHookHandlers({ config, surface, repoRoot: REPO_ROOT });
}

/** Every entry of one event in a set (there is at most one by design). */
function entriesFor(set: ReturnType<typeof buildSet>, event: "before_tool" | "after_tool") {
  return set.filter((entry) => entry.event === event);
}

// ─────────────────────────────────────────────────────────────────────────────
// Construction: scope filtering and deadlines
// ─────────────────────────────────────────────────────────────────────────────

describe("createAgentHookHandlers — the set it registers", () => {
  test("AC-1: every event empty returns an empty set", () => {
    expect(buildSet(hooksConfig())).toEqual([]);
  });

  test("AC-2: an entry scoped to run registers no before_tool entry on the chat surface", () => {
    const config = hooksConfig({ PreToolUse: [hook({ command: "guard.sh", scope: ["run"] })] });

    const set = buildSet(config, "chat");

    expect(entriesFor(set, "before_tool")).toHaveLength(0);
    expect(set).toEqual([]);
  });

  test("AC-3: one before_tool entry whose deadline covers every entry it may run", () => {
    const config = hooksConfig({
      PreToolUse: [hook({ command: "a.sh", timeoutMs: 2000 }), hook({ command: "b.sh", timeoutMs: 3000 })],
    });

    const set = buildSet(config, "run");

    const beforeTool = entriesFor(set, "before_tool");
    expect(beforeTool).toHaveLength(1);
    expect(beforeTool[0].plugin).toBe(AGENT_HOOKS_PLUGIN);
    // 1000 + (2000 + 5000 + 2000) + (3000 + 5000 + 2000)
    expect(beforeTool[0].timeoutMs).toBe(20_000);
  });

  test("AC-4: a post-only config still registers a record-only before_tool entry", () => {
    const config = hooksConfig({ PostToolUse: [hook({ command: "fmt.sh", timeoutMs: 4000 })] });

    const set = buildSet(config, "run");

    expect(loopHandlerEntry(set, "after_tool").timeoutMs).toBe(12_000);
    // 1000: the handler margin alone, because it runs no PreToolUse entry.
    expect(loopHandlerEntry(set, "before_tool").timeoutMs).toBe(1000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PreToolUse: which calls a matcher covers
// ─────────────────────────────────────────────────────────────────────────────

/** How many hook entries one `before_tool` dispatch of `toolName` ran. */
async function runsFor(config: AgentHooksConfig, toolName: string): Promise<number> {
  answerNext();
  await callBeforeTool(buildSet(config), beforeToolPayload(toolName, {}), handlerContext());
  return runs.length;
}

describe("before_tool — the matcher", () => {
  test("AC-5: 'Bash' matches Bash and not BashOutput: the match is anchored to the whole name", async () => {
    const config = hooksConfig({ PreToolUse: [hook({ command: "guard.sh", matcher: "Bash" })] });

    expect(await runsFor(config, "Bash")).toBe(1);
    expect(await runsFor(config, "BashOutput")).toBe(0);
  });

  test('AC-6: an alternation covers each alternative; absent and "*" cover every call', async () => {
    const alternation = hooksConfig({ PreToolUse: [hook({ command: "guard.sh", matcher: "Write|Edit" })] });
    expect(await runsFor(alternation, "Write")).toBe(1);
    expect(await runsFor(alternation, "Edit")).toBe(1);
    expect(await runsFor(alternation, "Read")).toBe(0);

    expect(await runsFor(hooksConfig({ PreToolUse: [hook({ command: "guard.sh" })] }), "Read")).toBe(1);
    expect(await runsFor(hooksConfig({ PreToolUse: [hook({ command: "guard.sh", matcher: "*" })] }), "Bash")).toBe(1);
  });

  test("AC-15: a call no entry matches is allowed and no hook is run", async () => {
    const set = buildSet(hooksConfig({ PreToolUse: [hook({ command: "guard.sh", matcher: "Bash" })] }));

    answerNext();
    const outcome = await callBeforeTool(set, beforeToolPayload("Read", { path: "a.ts" }), handlerContext());

    expect(outcome).toEqual({ kind: "allow" });
    expect(runs).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PreToolUse: the payload handed to the hook
// ─────────────────────────────────────────────────────────────────────────────

describe("before_tool — the payload", () => {
  test("AC-7: carries the event, session, surface, cwd, tool and the context's facts", async () => {
    const set = buildSet(hooksConfig({ PreToolUse: [hook({ command: "guard.sh" })] }), "run");
    const ctx = handlerContext({
      sessionName: "sess-payload",
      role: "wf-implementer",
      feature: "agent-hooks",
      storyId: "US-004",
      model: "claude-sonnet-4",
    });

    answerNext();
    await callBeforeTool(set, beforeToolPayload("Bash", { command: "git push" }), ctx);

    expect(runs).toHaveLength(1);
    expect(runs[0].entry.command).toBe("guard.sh");
    expect(runs[0].payload).toMatchObject({
      hook_event_name: "PreToolUse",
      session_id: "sess-payload",
      surface: "run",
      cwd: REPO_ROOT,
      tool_name: "Bash",
      tool_input: { command: "git push" },
      role: "wf-implementer",
      feature: "agent-hooks",
      story_id: "US-004",
      model: "claude-sonnet-4",
    });
  });

  test("AC-7: the context facts it does not carry are absent from the payload", async () => {
    const set = buildSet(hooksConfig({ PreToolUse: [hook({ command: "guard.sh" })] }));

    answerNext();
    await callBeforeTool(set, beforeToolPayload("Bash", {}), handlerContext());

    for (const key of ["role", "feature", "model"]) expect(key in runs[0].payload).toBe(false);
  });

  test("AC-8: cwd is the context's workdir when present, else the factory's repoRoot", async () => {
    const set = buildSet(hooksConfig({ PreToolUse: [hook({ command: "guard.sh" })] }));

    answerNext();
    await callBeforeTool(set, beforeToolPayload("Bash", {}), handlerContext({ workdir: "/work/tree" }));
    expect(runs[0].cwd).toBe("/work/tree");
    expect(runs[0].payload.cwd).toBe("/work/tree");

    answerNext();
    await callBeforeTool(set, beforeToolPayload("Bash", {}), handlerContext());
    expect(runs[0].cwd).toBe(REPO_ROOT);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PreToolUse: what one entry's answer becomes
// ─────────────────────────────────────────────────────────────────────────────

describe("before_tool — a hook's answer", () => {
  test("AC-9: a block run blocks the call and stops the chain", async () => {
    const set = buildSet(hooksConfig({ PreToolUse: [hook({ command: "no-push.sh" }), hook({ command: "later.sh" })] }));

    answerNext([{ kind: "block", reason: "no push" }]);
    const outcome = await callBeforeTool(set, beforeToolPayload("Bash", { command: "git push" }), handlerContext());

    expect(outcome).toEqual({ kind: "block", content: "Blocked by hook: no push" });
    expect(runs).toHaveLength(1);
    expect(runs[0].entry.command).toBe("no-push.sh");
  });

  test('AC-10: a JSON decision "block" blocks the call with its reason', async () => {
    const set = buildSet(hooksConfig({ PreToolUse: [hook({ command: "guard.sh" })] }));

    answerNext([{ kind: "ok", stdout: "", json: { decision: "block", reason: "r" } }]);
    const outcome = await callBeforeTool(set, beforeToolPayload("Bash", {}), handlerContext());

    expect(outcome).toEqual({ kind: "block", content: "Blocked by hook: r" });
  });

  test("AC-11: an error run fails closed with the command and the error in the content", async () => {
    const set = buildSet(hooksConfig({ PreToolUse: [hook({ command: "guard.sh" })] }));

    answerNext([{ kind: "error", reason: "exited 1" }]);
    const outcome = await callBeforeTool(set, beforeToolPayload("Bash", {}), handlerContext());

    expect(outcome).toMatchObject({ kind: "block", isError: true });
    expect(outcomeText(outcome)).toContain("guard.sh");
    expect(outcomeText(outcome)).toContain("exited 1");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PreToolUse: combining several entries
// ─────────────────────────────────────────────────────────────────────────────

describe("before_tool — combining several entries", () => {
  test("AC-12: an updatedInput rewrite is what the next entry sees and what the call runs", async () => {
    const set = buildSet(
      hooksConfig({ PreToolUse: [hook({ command: "rewrite.sh" }), hook({ command: "observer.sh" })] }),
    );

    answerNext([
      { kind: "ok", stdout: "", json: { updatedInput: { command: "ls -la" } } },
      { kind: "ok", stdout: "" },
    ]);
    const outcome = await callBeforeTool(set, beforeToolPayload("Bash", { command: "git push" }), handlerContext());

    expect(runs[1].payload.tool_input).toEqual({ command: "ls -la" });
    expect(outcome).toEqual({ kind: "allow", input: { command: "ls -la" } });
  });

  test("AC-13: the entries' additionalContext strings become one nudge, in order", async () => {
    const set = buildSet(hooksConfig({ PreToolUse: [hook({ command: "a.sh" }), hook({ command: "b.sh" })] }));

    answerNext([
      { kind: "ok", stdout: "", json: { additionalContext: "careful" } },
      { kind: "ok", stdout: "", json: { additionalContext: "really" } },
    ]);
    const outcome = await callBeforeTool(set, beforeToolPayload("Bash", {}), handlerContext());

    expect(outcome).toEqual({ kind: "nudge", text: "careful\n\nreally" });
  });

  test("AC-14: one entry answering both fields nudges with the rewritten input", async () => {
    const set = buildSet(hooksConfig({ PreToolUse: [hook({ command: "both.sh" })] }));

    answerNext([{ kind: "ok", stdout: "", json: { updatedInput: { a: 1 }, additionalContext: "note" } }]);
    const outcome = await callBeforeTool(set, beforeToolPayload("Bash", {}), handlerContext());

    expect(outcome).toEqual({ kind: "nudge", text: "note", input: { a: 1 } });
  });

  test("AC-21: an updatedInput that is not a JSON object is ignored with one warning naming the command", async () => {
    const set = buildSet(hooksConfig({ PreToolUse: [hook({ command: "bad-rewrite.sh" })] }));

    await withWarnSpy(async (spy) => {
      answerNext([{ kind: "ok", stdout: "", json: { updatedInput: "rm -rf" } }]);
      const outcome = await callBeforeTool(set, beforeToolPayload("Bash", { command: "git push" }), handlerContext());

      expect(outcome).toEqual({ kind: "allow" });

      const warnings = spy.mock.calls.filter((call) => call[0] === "agent-hooks");
      expect(warnings).toHaveLength(1);
      expect(warnings[0][1]).toContain("bad-rewrite.sh");
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PostToolUse: the call input the result belongs to
// ─────────────────────────────────────────────────────────────────────────────

/** A pre entry rewriting the call plus a post entry that sees it. */
function rewritingSet(): ReturnType<typeof buildSet> {
  return buildSet(
    hooksConfig({
      PreToolUse: [hook({ command: "rewrite.sh", matcher: "Write" })],
      PostToolUse: [hook({ command: "fmt.sh" })],
    }),
  );
}

describe("after_tool — the recorded call input", () => {
  test("AC-16: the result's hook is told the input the call actually ran with", async () => {
    const set = rewritingSet();
    const ctx = handlerContext();

    answerNext([{ kind: "ok", stdout: "", json: { updatedInput: { path: "b.ts" } } }]);
    await callBeforeTool(set, beforeToolPayload("Write", { path: "a.ts" }, "c1"), ctx);

    answerNext();
    const patch = await callAfterTool(
      set,
      afterToolPayload({ content: "written", toolName: "Write", callId: "c1" }),
      ctx,
    );

    expect(runs).toHaveLength(1);
    expect(runs[0].payload).toMatchObject({
      hook_event_name: "PostToolUse",
      tool_name: "Write",
      tool_input: { path: "b.ts" },
      tool_response: { content: "written", is_error: false },
    });
    expect(patch).toBeUndefined();
  });

  test("AC-17: the record is deleted once read, and a payload without callId carries no tool_input", async () => {
    const set = rewritingSet();
    const ctx = handlerContext();

    answerNext([{ kind: "ok", stdout: "", json: { updatedInput: { path: "b.ts" } } }]);
    await callBeforeTool(set, beforeToolPayload("Write", { path: "a.ts" }, "c1"), ctx);
    answerNext();
    await callAfterTool(set, afterToolPayload({ content: "written", toolName: "Write", callId: "c1" }), ctx);

    answerNext();
    await callAfterTool(set, afterToolPayload({ content: "again", toolName: "Write", callId: "c1" }), ctx);
    expect(runs).toHaveLength(1);
    expect("tool_input" in runs[0].payload).toBe(false);

    answerNext();
    await callAfterTool(set, afterToolPayload({ content: "anonymous", toolName: "Write" }), ctx);
    expect(runs).toHaveLength(1);
    expect("tool_input" in runs[0].payload).toBe(false);
  });

  test("records whose after_tool never arrives are capped per session, oldest evicted first", async () => {
    const set = rewritingSet();
    const ctx = handlerContext();

    // Calls blocked by a later plugin, or abandoned mid-turn, never reach
    // after_tool; without a cap each leaves its input behind for the process.
    for (let index = 0; index <= AGENT_HOOK_MAX_RECORDED_CALLS; index++) {
      answerNext();
      await callBeforeTool(set, beforeToolPayload("Write", { path: `f${index}.ts` }, `c${index}`), ctx);
    }

    answerNext();
    await callAfterTool(set, afterToolPayload({ content: "late", toolName: "Write", callId: "c0" }), ctx);
    expect("tool_input" in runs[0].payload).toBe(false);

    answerNext();
    const newest = `c${AGENT_HOOK_MAX_RECORDED_CALLS}`;
    await callAfterTool(set, afterToolPayload({ content: "ok", toolName: "Write", callId: newest }), ctx);
    expect(runs[0].payload).toMatchObject({ tool_input: { path: `f${AGENT_HOOK_MAX_RECORDED_CALLS}.ts` } });
  });

  test("AC-18: the same call id in two sessions keeps each session's own input", async () => {
    const set = rewritingSet();
    const sessionOne = handlerContext({ sessionName: "s1" });
    const sessionTwo = handlerContext({ sessionName: "s2" });

    answerNext([
      { kind: "ok", stdout: "" },
      { kind: "ok", stdout: "" },
    ]);
    await callBeforeTool(set, beforeToolPayload("Write", { path: "a.ts" }, "c1"), sessionOne);
    await callBeforeTool(set, beforeToolPayload("Write", { path: "b.ts" }, "c1"), sessionTwo);

    answerNext();
    await callAfterTool(set, afterToolPayload({ content: "one", toolName: "Write", callId: "c1" }), sessionOne);
    expect(runs[0].payload.tool_input).toEqual({ path: "a.ts" });

    answerNext();
    await callAfterTool(set, afterToolPayload({ content: "two", toolName: "Write", callId: "c1" }), sessionTwo);
    expect(runs[0].payload.tool_input).toEqual({ path: "b.ts" });
  });

  test("AC-19: a call no PostToolUse entry matches is never recorded", async () => {
    const set = buildSet(hooksConfig({ PostToolUse: [hook({ command: "fmt.sh", matcher: "Write" })] }));
    const ctx = handlerContext();

    answerNext();
    await callBeforeTool(set, beforeToolPayload("Read", { path: "a.ts" }, "c2"), ctx);

    answerNext();
    const patch = await callAfterTool(set, afterToolPayload({ content: "read", toolName: "Read", callId: "c2" }), ctx);

    expect(patch).toBeUndefined();
    expect(runs).toHaveLength(0);
  });

  test("AC-24: a result whose tool no entry matches is left alone", async () => {
    const set = buildSet(hooksConfig({ PostToolUse: [hook({ command: "fmt.sh", matcher: "Write" })] }));

    answerNext();
    const patch = await callAfterTool(
      set,
      afterToolPayload({ content: "read", toolName: "Read", callId: "c3" }),
      handlerContext(),
    );

    expect(patch).toBeUndefined();
    expect(runs).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PostToolUse: what a hook's answer appends to the result
// ─────────────────────────────────────────────────────────────────────────────

describe("after_tool — a hook's answer", () => {
  test('AC-20: a JSON decision "block" without a reason appends feedback naming the hook', async () => {
    const set = buildSet(hooksConfig({ PostToolUse: [hook({ command: "fmt.sh" })] }));

    answerNext([{ kind: "ok", stdout: "", json: { decision: "block" } }]);
    const patch = await callAfterTool(
      set,
      afterToolPayload({ content: "body", toolName: "Write", callId: "c1" }),
      handlerContext(),
    );

    expect(patch).toEqual({ content: "body\n\nHook feedback: blocked by hook 'fmt.sh'" });
  });

  test("AC-22: a block run and a context both append, in entry order", async () => {
    const set = buildSet(hooksConfig({ PostToolUse: [hook({ command: "lint.sh" }), hook({ command: "fmt.sh" })] }));

    answerNext([
      { kind: "block", reason: "lint failed" },
      { kind: "ok", stdout: "", json: { additionalContext: "formatted" } },
    ]);
    const patch = await callAfterTool(
      set,
      afterToolPayload({ content: "body", toolName: "Write", callId: "c1" }),
      handlerContext(),
    );

    expect(patch).toEqual({ content: "body\n\nHook feedback: lint failed\n\nHook context: formatted" });
  });

  test("AC-23: an error run contributes no patch and warns once naming the command", async () => {
    const set = buildSet(hooksConfig({ PostToolUse: [hook({ command: "broken.sh" })] }));

    await withWarnSpy(async (spy) => {
      answerNext([{ kind: "error", reason: "exited 1" }]);
      const patch = await callAfterTool(
        set,
        afterToolPayload({ content: "body", toolName: "Write", callId: "c1" }),
        handlerContext(),
      );

      expect(patch).toBeUndefined();

      const warnings = spy.mock.calls.filter((call) => call[0] === "agent-hooks");
      expect(warnings).toHaveLength(1);
      expect(warnings[0][1]).toContain("broken.sh");
    });
  });
});
