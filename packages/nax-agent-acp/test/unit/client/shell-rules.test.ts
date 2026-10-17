/**
 * ACP shell-command adjudication (SPEC-cursor-pi-acp-read-only US-003): which raw
 * field carries an agent's shell command, and whether the operator's Bash rules
 * allow it. The pi gate extension source is exercised as the module it is: written
 * to a temp file and imported (US-004 writes it to disk for real).
 */
import { describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { cleanupTempDir, makeTempDir } from "@nathapp/nax-test-kit/bun/temp";
import type { AcpPermissionRules, AcpRule } from "#src/client/rule-policy";
import {
  PI_SHELL_GATE_SOURCE,
  PI_SHELL_GATE_TITLE,
  SHELL_RULE_REASON,
  shellCommandOf,
  shellRuleVerdict,
} from "#src/client/shell-rules";

const rule = (tool: string, patterns: readonly string[]): AcpRule => ({ tool, patterns });

/** Rules whose `allow`, `deny` and `ask` lists are given by name; the rest stay empty. */
function rules(given: {
  readonly allow?: readonly AcpRule[];
  readonly deny?: readonly AcpRule[];
  readonly ask?: readonly AcpRule[];
}): AcpPermissionRules {
  return { allow: given.allow ?? [], deny: given.deny ?? [], ask: given.ask ?? [] };
}

const bashAllow = (patterns: readonly string[]): AcpPermissionRules => rules({ allow: [rule("Bash", patterns)] });

const NO_RULES: AcpPermissionRules = rules({});

describe("the pinned constants (SPEC-cursor-pi-acp-read-only US-003)", () => {
  test("the reason and the pi gate title are exactly what the design names", () => {
    expect(SHELL_RULE_REASON).toBe("an operator Bash rule allows this command");
    expect(PI_SHELL_GATE_TITLE).toBe("nax: run shell command");
  });
});

describe("shellCommandOf: which raw field carries a shell command (AC-1 to AC-7)", () => {
  test("AC-1: another agent's execute rawInput.command", () => {
    expect(
      shellCommandOf("opencode", { kind: "execute", title: "x", rawInput: { command: "git status --short" } }),
    ).toBe("git status --short");
  });

  test("AC-2: cursor's backticked title, one pair of backticks removed", () => {
    expect(shellCommandOf("cursor", { kind: "execute", title: "`git status --short`" })).toBe("git status --short");
  });

  test("AC-3: cursor's plain title is returned unchanged", () => {
    expect(shellCommandOf("cursor", { kind: "execute", title: "ls -la" })).toBe("ls -la");
  });

  test("AC-4: the pi gate's confirm message", () => {
    expect(
      shellCommandOf("pi", {
        kind: "other",
        title: PI_SHELL_GATE_TITLE,
        rawInput: { method: "confirm", title: PI_SHELL_GATE_TITLE, message: "ls -la" },
      }),
    ).toBe("ls -la");
  });

  test("AC-5: pi yields nothing for a confirm prompt that is not the gate's", () => {
    expect(
      shellCommandOf("pi", { kind: "other", rawInput: { method: "confirm", title: "Delete?", message: "ls" } }),
    ).toBeUndefined();
  });

  test("AC-6: a non-execute call yields nothing", () => {
    expect(shellCommandOf("opencode", { kind: "edit", rawInput: { command: "ls" } })).toBeUndefined();
  });

  test("AC-7: an execute call with no command yields nothing", () => {
    expect(shellCommandOf("opencode", { kind: "execute", rawInput: {} })).toBeUndefined();
  });

  test.each([
    ["a null tool call", "opencode", null],
    ["a non-object tool call", "opencode", 7],
    ["pi of kind execute", "pi", { kind: "execute", rawInput: { command: "ls" } }],
    [
      "pi with the gate title but another method",
      "pi",
      { kind: "other", rawInput: { method: "ask", title: PI_SHELL_GATE_TITLE, message: "ls" } },
    ],
    [
      "pi with an empty message",
      "pi",
      { kind: "other", rawInput: { method: "confirm", title: PI_SHELL_GATE_TITLE, message: "" } },
    ],
    [
      "pi with a non-string message",
      "pi",
      { kind: "other", rawInput: { method: "confirm", title: PI_SHELL_GATE_TITLE, message: 7 } },
    ],
    ["cursor with an empty title", "cursor", { kind: "execute", title: "" }],
    ["cursor with a non-string title", "cursor", { kind: "execute", title: 7 }],
    ["an agent with an empty command", "opencode", { kind: "execute", rawInput: { command: "" } }],
    ["an agent with a non-string command", "opencode", { kind: "execute", rawInput: { command: 7 } }],
  ])("yields undefined for %s", (_label, agentName, toolCall) => {
    expect(shellCommandOf(agentName as string, toolCall)).toBeUndefined();
  });
});

describe("shellRuleVerdict: the operator's Bash rules decide (AC-8 to AC-18, AC-36)", () => {
  test("AC-8: a matching allow rule allows", () => {
    expect(shellRuleVerdict("git status --short", bashAllow(["git status*"]))).toBe("allow");
  });

  test("AC-9: no rules deny", () => {
    expect(shellRuleVerdict("git status --short", NO_RULES)).toBe("deny");
  });

  test("AC-10: a redirect is never allowed, even under an unconditional allow", () => {
    expect(shellRuleVerdict("echo hi > shell.txt", bashAllow(["*"]))).toBe("deny");
  });

  test("AC-11: every segment must match an allow rule", () => {
    expect(shellRuleVerdict("git status && rm -rf x", bashAllow(["git status*"]))).toBe("deny");
  });

  test("AC-12: both segments matching allows", () => {
    expect(shellRuleVerdict("git status && ls -la", bashAllow(["git status*", "ls *"]))).toBe("allow");
  });

  test("AC-13: a deny rule outranks an unconditional allow", () => {
    expect(
      shellRuleVerdict(
        "git push origin main",
        rules({ allow: [rule("Bash", ["*"])], deny: [rule("Bash", ["git push*"])] }),
      ),
    ).toBe("deny");
  });

  test("AC-14: an ask rule denies too - no person answers an ACP session", () => {
    expect(
      shellRuleVerdict(
        "git push origin main",
        rules({ allow: [rule("Bash", ["*"])], ask: [rule("Bash", ["git push*"])] }),
      ),
    ).toBe("deny");
  });

  test("AC-15: the lexer refuses a command substitution, an unconditional allow or not", () => {
    expect(shellRuleVerdict("echo $(cat secret)", bashAllow(["*"]))).toBe("deny");
  });

  test("AC-16: only a Bash rule allows a command", () => {
    expect(shellRuleVerdict("ls", rules({ allow: [rule("Read", ["*"])] }))).toBe("deny");
  });

  test("AC-17: native prefix matching leaves trailing arguments unconstrained", () => {
    expect(shellRuleVerdict("git status --short", bashAllow(["git status"]))).toBe("allow");
  });

  test("AC-18: fewer argv tokens than the pattern has is not a match", () => {
    expect(shellRuleVerdict("git", bashAllow(["git status"]))).toBe("deny");
  });

  test.each([
    ["a lexer-refused command substitution", "echo $(cat secret)"],
    ["a redirect", "echo hi > shell.txt"],
    ["an opaque token", "echo $HOME"],
  ])("AC-36: %s stays denied under an unconditional Bash allow", (_label, command) => {
    expect(shellRuleVerdict(command, bashAllow(["*"]))).toBe("deny");
  });

  test.each([
    ["an empty command", ""],
    ["a whitespace-only command", "   "],
    ["a trailing control operator", "git status &&"],
    ["an unbalanced quote", "git status 'x"],
    ["a subshell", "(git status)"],
    ["a here-document", "cat <<EOF"],
  ])("a command the lexer refuses denies: %s", (_label, command) => {
    expect(shellRuleVerdict(command, bashAllow(["*"]))).toBe("deny");
  });

  test.each([
    ["a separate segment", "git status; ls -la"],
    ["a pipe", "git status | cat"],
    ["an || branch", "git status || ls -la"],
  ])("%s is adjudicated segment by segment", (_label, command) => {
    expect(shellRuleVerdict(command, bashAllow(["git status*", "ls *", "cat"]))).toBe("allow");
    expect(shellRuleVerdict(command, bashAllow(["git status*"]))).toBe("deny");
  });

  test("the deny and ask checks read Bash rules only", () => {
    expect(shellRuleVerdict("ls", rules({ allow: [rule("Bash", ["*"])], deny: [rule("Read", ["*"])] }))).toBe("allow");
  });
});

/** The pi gate extension, as pi loads it: a module whose default export registers handlers. */
type Handler = (event: unknown, ctx: unknown) => unknown;

interface LoadedGate {
  readonly handlers: ReadonlyMap<string, Handler>;
}

async function loadGate(): Promise<LoadedGate> {
  const dir = makeTempDir("nax-shell-gate-");
  try {
    const file = join(dir, "shell-gate.ts");
    await writeFile(file, PI_SHELL_GATE_SOURCE, "utf8");
    const mod = (await import(pathToFileURL(file).href)) as { default: (pi: unknown) => void };
    const handlers = new Map<string, Handler>();
    const pi = {
      on(event: string, handler: Handler) {
        handlers.set(event, handler);
        return pi;
      },
    };
    mod.default(pi);
    return { handlers };
  } finally {
    cleanupTempDir(dir);
  }
}

/** A ctx as pi hands it to a handler; `confirm` records every call. */
function gateCtx(hasUI: boolean, answer = true) {
  const confirmCalls: (readonly [string, string])[] = [];
  const ctx = {
    hasUI,
    ui: {
      confirm: async (title: string, message: string) => {
        confirmCalls.push([title, message]);
        return answer;
      },
    },
  };
  return { ctx, confirmCalls };
}

const BASH = { toolName: "bash", input: { command: "ls" } };
const BLOCKED = { block: true, reason: "nax: shell command rejected" };

describe("the pi gate extension source (AC-27 to AC-34)", () => {
  test("AC-27: importing it and calling its default export registers a tool_call handler", async () => {
    const { handlers } = await loadGate();
    expect([...handlers.keys()]).toEqual(["tool_call"]);
  });

  test("AC-28: an allowed bash call returns undefined and AC-29 asks confirm once with the title and command", async () => {
    const { handlers } = await loadGate();
    const { ctx, confirmCalls } = gateCtx(true, true);
    expect(await handlers.get("tool_call")?.(BASH, ctx)).toBeUndefined();
    expect(confirmCalls).toEqual([[PI_SHELL_GATE_TITLE, "ls"]]);
  });

  test("AC-30: a rejected bash call is blocked with the engine's reason", async () => {
    const { handlers } = await loadGate();
    const { ctx } = gateCtx(true, false);
    expect(await handlers.get("tool_call")?.(BASH, ctx)).toEqual(BLOCKED);
  });

  test("AC-31 and AC-32: with no UI the call is blocked and nobody is asked", async () => {
    const { handlers } = await loadGate();
    const { ctx, confirmCalls } = gateCtx(false, true);
    expect(await handlers.get("tool_call")?.(BASH, ctx)).toMatchObject({ block: true });
    expect(confirmCalls).toEqual([]);
  });

  test("AC-33 and AC-34: a non-bash tool call is left alone and nobody is asked", async () => {
    const { handlers } = await loadGate();
    const { ctx, confirmCalls } = gateCtx(true, true);
    expect(await handlers.get("tool_call")?.({ toolName: "read", input: {} }, ctx)).toBeUndefined();
    expect(confirmCalls).toEqual([]);
  });

  test("a ctx without a UI at all is treated as no UI", async () => {
    const { handlers } = await loadGate();
    expect(await handlers.get("tool_call")?.(BASH, { hasUI: true })).toMatchObject({ block: true });
  });

  test("a bash call with no readable command is blocked without asking", async () => {
    const { handlers } = await loadGate();
    const { ctx, confirmCalls } = gateCtx(true, true);
    expect(await handlers.get("tool_call")?.({ toolName: "bash", input: {} }, ctx)).toMatchObject({ block: true });
    expect(confirmCalls).toEqual([]);
  });
});
