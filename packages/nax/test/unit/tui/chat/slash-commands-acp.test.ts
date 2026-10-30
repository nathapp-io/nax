/**
 * US-012 AC-1..AC-15: on an ACP brain `/skills`, `/mcp` and `/agents` step aside, a slash line that
 * is not a built-in goes to the agent as typed, `/help` and the slash menu list built-ins only, and
 * the other built-ins behave as on a native host.
 */
import { describe, expect, test } from "bun:test";
import { type ChatHost, type ChatHostState, createChatAskController } from "@/chat";
import { NaxError } from "@/errors";
import {
  buildResourceCatalog,
  type CommandResource,
  formatSkillsListing,
  type ResourceCatalog,
  type SkillResource,
} from "@/resources";
import { COMMAND_DESCRIPTIONS, COMMANDS, parseSlashCommand, runSlashCommand } from "@/tui/chat/slash-commands";
import { slashMenuItems } from "@/tui/chat/slash-menu";

const ORIGIN = { kind: "claude-project" } as const;
const NATIVE_MODEL = "openai/gpt-6";
const ACP_MODEL = "acp:codex";

const review: CommandResource = {
  kind: "command",
  name: "review",
  qualifiedName: "review",
  description: "Review code",
  template: "Review $ARGUMENTS",
  path: "/kit/review.md",
  origin: ORIGIN,
};
const brainstorming: SkillResource = {
  kind: "skill",
  name: "brainstorming",
  qualifiedName: "brainstorming",
  description: "Explore ideas",
  body: "Brainstorm",
  baseDir: "/kit/brainstorming",
  path: "/kit/brainstorming/SKILL.md",
  modelInvocable: true,
  origin: ORIGIN,
};

function makeCatalog(): ResourceCatalog {
  return buildResourceCatalog([
    {
      id: "claude-project",
      origin: ORIGIN,
      root: "/kit",
      commands: [review],
      skills: [brainstorming],
      agents: [],
      mcpServers: [],
      hooks: [],
      diagnostics: [],
    },
  ]);
}

function stateOf(model: string): ChatHostState {
  return {
    sessionId: "s",
    mode: "guarded",
    model,
    meta: {
      schemaVersion: 1,
      sessionId: "s",
      cwd: "/repo",
      mode: "ask",
      model,
      bashApproval: "gated",
      title: null,
      createdAt: "now",
      updatedAt: null,
      costUsd: 1.236,
    },
  };
}

function makeHost(model: string): ChatHost {
  return {
    repoRoot: "/repo",
    catalog: makeCatalog(),
    models: [model],
    asks: createChatAskController({ mode: "guarded", answer: () => {} }),
    current: () => stateOf(model),
    notice: () => undefined,
    send: async () => {},
    start: async () => {},
    clear: async () => {},
    resume: async () => {},
    switchTo: async () => {},
    cancel: () => {},
    close: async () => {},
    listSessions: async () => [],
  };
}

async function run(host: ChatHost, line: string) {
  const shown: string[] = [];
  const command = parseSlashCommand(line);
  if (!command) throw new Error("fixture must be a slash command");
  const outcome = await runSlashCommand(command, { host, show: (text) => shown.push(text) });
  return { outcome, shown };
}

describe("runSlashCommand on an ACP brain", () => {
  test.each([
    ["AC-1", "/skills", "/skills is not available on Codex: it uses its own skills"],
    ["AC-2", "/mcp", "/mcp is not available on Codex: it uses its own MCP servers"],
    ["AC-3", "/agents", "/agents is not available on Codex: it uses its own subagents"],
  ])("%s %s says it is not available", async (_ac, line, text) => {
    const { outcome, shown } = await run(makeHost(ACP_MODEL), line);
    expect(outcome).toBeUndefined();
    expect(shown).toEqual([text]);
  });

  test("names the agent the brain is, not a fixed one", async () => {
    const { shown } = await run(makeHost("acp:claude/opus[high]"), "/skills");
    expect(shown).toEqual(["/skills is not available on Claude Code: it uses its own skills"]);
  });

  test.each([
    ["AC-4", "/review the diff", "/review the diff"],
    ["AC-5", "/brainstorming", "/brainstorming"],
    ["AC-6", "/unknownthing x", "/unknownthing x"],
  ])("%s sends %s to the agent as typed", async (_ac, line, message) => {
    const { outcome, shown } = await run(makeHost(ACP_MODEL), line);
    expect(outcome).toEqual({ kind: "send", message });
    expect(shown).toEqual([]);
  });

  test("keeps the arguments' spacing exactly as typed", async () => {
    const { outcome } = await run(makeHost(ACP_MODEL), "/review  a.ts   b.ts");
    expect(outcome).toEqual({ kind: "send", message: "/review  a.ts   b.ts" });
  });

  test("AC-7 /help lists the built-ins and no catalog command or skill", async () => {
    const { shown } = await run(makeHost(ACP_MODEL), "/help");
    expect(shown).toEqual([COMMANDS.map((name) => `/${name}  ${COMMAND_DESCRIPTIONS[name]}`).join("\n")]);
    expect(shown[0]).not.toContain("/review");
    expect(shown[0]).not.toContain("/brainstorming");
  });

  test("AC-8 /model with no argument still opens the model picker", async () => {
    const { outcome } = await run(makeHost(ACP_MODEL), "/model");
    expect(outcome).toEqual({ kind: "picker", picker: "model" });
  });

  test.each([
    ["AC-9", "/jobs"],
    ["AC-10", "/cost"],
  ])("%s %s shows what a native host shows", async (_ac, line) => {
    const native = await run(makeHost(NATIVE_MODEL), line);
    const acp = await run(makeHost(ACP_MODEL), line);
    expect(acp.shown.length).toBeGreaterThan(0);
    expect(acp.shown).toEqual(native.shown);
    expect(acp.outcome).toBeUndefined();
  });
});

describe("runSlashCommand on a native brain", () => {
  test("AC-11 /skills shows the skills listing", async () => {
    const { outcome, shown } = await run(makeHost(NATIVE_MODEL), "/skills");
    expect(outcome).toBeUndefined();
    expect(shown).toEqual([formatSkillsListing(makeCatalog())]);
    expect(shown[0]).toContain("brainstorming");
  });

  test("AC-12 an unknown command is reported", async () => {
    const { outcome, shown } = await run(makeHost(NATIVE_MODEL), "/unknownthing");
    expect(outcome).toBeUndefined();
    expect(shown).toEqual(["unknown command /unknownthing"]);
  });
});

describe("slashMenuItems with an ACP brain", () => {
  const catalog = makeCatalog();

  test("AC-13 offers exactly the built-ins in COMMANDS order", () => {
    const items = slashMenuItems({ catalog, current: () => stateOf(ACP_MODEL) });
    expect(items).toEqual(COMMANDS.map((name) => ({ name, description: COMMAND_DESCRIPTIONS[name] })));
  });

  test("AC-14 a host with only a catalog offers the built-ins then the catalog's entries", () => {
    const names = slashMenuItems({ catalog }).map((item) => item.name);
    expect(names).toEqual([...COMMANDS, "review", "brainstorming"]);
  });

  test("AC-15 a host whose current() throws CHAT_SESSION_NOT_OPEN offers the catalog's entries too", () => {
    const current = (): ChatHostState => {
      throw new NaxError("[chat] no session is open", "CHAT_SESSION_NOT_OPEN", { stage: "chat" });
    };
    const names = slashMenuItems({ catalog, current }).map((item) => item.name);
    expect(names).toEqual([...COMMANDS, "review", "brainstorming"]);
  });

  test("a native current model keeps the catalog's entries", () => {
    const names = slashMenuItems({ catalog, current: () => stateOf(NATIVE_MODEL) }).map((item) => item.name);
    expect(names).toEqual([...COMMANDS, "review", "brainstorming"]);
  });
});
