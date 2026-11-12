/**
 * US-015 — the `/memory` built-in.
 *
 * The command is a formatter with three sources behind it: the status and the index of the
 * chat's memory host, one sync's result, or a line saying memory is off or unreadable. It is
 * not one of the ACP-only features, so an ACP brain reaches its own memory through it too —
 * which is why the ACP case here asserts the same listing the native case shows.
 *
 * The help cases pin the built-in order word for word: `/memory` was inserted between `/jobs`
 * and `/quit`, and no other row moved.
 */

import { describe, expect, test } from "bun:test";
import type { MemorySyncResult, RenderedMemoryIndex } from "@nathapp/nax-agent";
import { type ChatHost, type ChatHostState, createChatAskController } from "@/chat";
import { formatMemoryStatus, type MemoryHost, type MemoryStatus } from "@/memory";
import { CHAT_KEYBOARD_HELP } from "@/tui/chat/help-text";
import {
  COMMAND_DESCRIPTIONS,
  COMMANDS,
  LISTING_TITLES,
  parseSlashCommand,
  runSlashCommand,
} from "@/tui/chat/slash-commands";

const NATIVE_MODEL = "openai/gpt-6";
const ACP_MODEL = "acp:codex";

/** The status the fake host reports; the listing a `/memory` run is compared against. */
const STATUS: MemoryStatus = {
  enabled: true,
  provider: "local",
  writeMode: "direct",
  projectDir: "/home/u/.nax/memory/projects/nax-monorepo-1a2b3c4d",
  userDir: "/home/u/.nax/memory/user",
  lastPullAt: "2026-11-02T08:11:00.000Z",
  lastError: null,
  queued: 0,
  rejected: 0,
  rejectedEntries: [],
  notes: { project: 3, user: 1, repo: 2 },
  repoSkipped: 0,
};

/** What the fake host renders: the index text `/memory` prints under the status block. */
const INDEX_TEXT = "# Memory\n- [project] staging-db — shared staging db";

/** The one sync result `/memory sync` prints. */
const SYNCED: MemorySyncResult = { outcome: "synced", pushed: 1, rejected: 0, pulled: 0, skipped: 0 };

/** The built-in help rows as they stood before `/memory` existed, in their order. */
const PREVIOUS_HELP_ROWS: readonly string[] = [
  "/help  Show commands and skills",
  "/mode  Switch permission mode",
  "/model  Switch model",
  "/effort  Switch reasoning effort",
  "/sessions  List saved sessions",
  "/resume  Resume a saved session",
  "/clear  Clear the conversation",
  "/cost  Show session cost",
  "/feature  Load a feature spec into the conversation",
  "/skills  List skills",
  "/plugins  List plugins and what they provide",
  "/image  Attach an image to the next message",
  "/mcp  List MCP servers",
  "/agents  List agents",
  // US-005: the compaction command sits between `/agents` and `/jobs`.
  "/compact  compact the conversation history",
  "/jobs  Show nax jobs and background tasks",
  "/quit  Quit nax chat",
];

/** The status the fake host reports, unless a case says otherwise. */
interface MemoryOverrides {
  readonly status?: () => Promise<MemoryStatus>;
  readonly renderIndex?: () => Promise<RenderedMemoryIndex>;
  readonly sync?: () => Promise<MemorySyncResult>;
}

/** A `MemoryHost` whose three `/memory` reads are the ones a case sets. */
function makeMemory(overrides: MemoryOverrides = {}): MemoryHost {
  const unused = async (): Promise<never> => {
    throw new Error("the /memory command reads none of this");
  };
  return {
    dirs: { root: "/m", projectDir: "/m/project", userDir: "/m/user" },
    providerId: "local",
    writeMode: "direct",
    notes: unused,
    getNote: unused,
    search: unused,
    renderIndex: overrides.renderIndex ?? (async () => ({ text: INDEX_TEXT, omitted: 0 })),
    sync: overrides.sync ?? (async () => SYNCED),
    status: overrides.status ?? (async () => STATUS),
    save: unused,
    forget: unused,
    approve: unused,
  };
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
      costUsd: 0,
    },
  };
}

/** A chat host on one model, with the memory host the case hands it. */
function makeHost(options: { readonly model?: string; readonly memory?: MemoryHost } = {}): ChatHost {
  const model = options.model ?? NATIVE_MODEL;
  return {
    repoRoot: "/repo",
    ...(options.memory === undefined ? {} : { memory: options.memory }),
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

/** Run one slash line against a host and keep every text the command showed. */
async function run(host: ChatHost, line: string): Promise<{ outcome: unknown; shown: readonly string[] }> {
  const shown: string[] = [];
  const command = parseSlashCommand(line);
  if (command === null) throw new Error("the fixture must be a slash command");
  const outcome = await runSlashCommand(command, { host, show: (text) => shown.push(text) });
  return { outcome, shown };
}

describe("the memory built-in", () => {
  test("AC-1 COMMANDS lists memory directly after jobs", () => {
    expect(COMMANDS[COMMANDS.indexOf("jobs") + 1]).toBe("memory");
  });

  test("AC-2 COMMANDS lists memory directly before quit", () => {
    expect(COMMANDS[COMMANDS.indexOf("memory") + 1]).toBe("quit");
  });

  test("AC-3 its description is the one the brief fixes", () => {
    expect(COMMAND_DESCRIPTIONS.memory).toBe("Show memory notes and sync status");
  });

  test("AC-4 its listing is titled Memory", () => {
    expect(LISTING_TITLES.get("memory")).toBe("Memory");
  });
});

describe("runSlashCommand for /memory", () => {
  test("AC-5 shows the status block and the index", async () => {
    const { outcome, shown } = await run(makeHost({ memory: makeMemory() }), "/memory");
    expect(outcome).toBeUndefined();
    expect(shown).toEqual([formatMemoryStatus(STATUS, INDEX_TEXT)]);
  });

  test("AC-6 without a memory host it says memory is disabled", async () => {
    const { outcome, shown } = await run(makeHost(), "/memory");
    expect(outcome).toBeUndefined();
    expect(shown).toEqual(["memory is disabled in this session"]);
  });

  test("AC-7 a failing status read is reported as memory unavailable", async () => {
    const status = () => Promise.reject(new Error("disk full"));
    const { shown } = await run(makeHost({ memory: makeMemory({ status }) }), "/memory");
    expect(shown).toEqual(["memory unavailable: disk full"]);
  });

  test("AC-20 a failing index render is reported as memory unavailable", async () => {
    const renderIndex = () => Promise.reject(new Error("disk full"));
    const { shown } = await run(makeHost({ memory: makeMemory({ renderIndex }) }), "/memory");
    expect(shown).toEqual(["memory unavailable: disk full"]);
  });

  test("AC-8 sync runs one sync and prints its result", async () => {
    const { shown } = await run(makeHost({ memory: makeMemory() }), "/memory sync");
    expect(shown).toEqual(["memory sync: synced (pushed 1, rejected 0, pulled 0, skipped 0)"]);
  });

  test("AC-9 any other argument prints the usage line", async () => {
    const { shown } = await run(makeHost({ memory: makeMemory() }), "/memory purge");
    expect(shown).toEqual(["usage: /memory [sync]"]);
  });

  test("AC-10 an ACP brain shows the same listing a native one does", async () => {
    const { outcome, shown } = await run(makeHost({ model: ACP_MODEL, memory: makeMemory() }), "/memory");
    expect(outcome).toBeUndefined();
    expect(shown).toEqual([formatMemoryStatus(STATUS, INDEX_TEXT)]);
  });

  test("a sync is not run by a plain /memory", async () => {
    let syncs = 0;
    const sync = async (): Promise<MemorySyncResult> => {
      syncs += 1;
      return SYNCED;
    };
    await run(makeHost({ memory: makeMemory({ sync }) }), "/memory");
    expect(syncs).toBe(0);
  });
});

describe("runSlashCommand for /help with the memory built-in", () => {
  test("AC-21 inserts only the memory row, between jobs and quit", async () => {
    const { shown } = await run(makeHost({ memory: makeMemory() }), "/help");
    const quitRow = PREVIOUS_HELP_ROWS.indexOf("/quit  Quit nax chat");
    const expected = [
      ...PREVIOUS_HELP_ROWS.slice(0, quitRow),
      "/memory  Show memory notes and sync status",
      ...PREVIOUS_HELP_ROWS.slice(quitRow),
      // US-005: this host has no catalog, so no summary row is inserted at all — exactly one
      // blank row separates the command rows from the keyboard block.
      "",
      CHAT_KEYBOARD_HELP,
    ].join("\n");
    expect(shown).toEqual([expected]);
  });
});
