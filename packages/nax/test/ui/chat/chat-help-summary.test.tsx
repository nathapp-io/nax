/**
 * US-005 — `/help` on the mounted screen, with a catalog that holds one command.
 *
 * The summary row is the only place `/help` shows the catalog at all, and it used to read
 * `1 commands`. This case mounts the real screen over a one-command, no-skill catalog, submits
 * `/help` the way a terminal does, and reads the frame: the row the transcript drew must be
 * singular and must still point at `/` search.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import { act } from "react";
import { type ChatHost, type ChatHostState, createChatAskController } from "@/chat";
import { buildResourceCatalog, type CommandResource } from "@/resources";
import { ChatApp } from "@/tui/chat";

const RETURN = "\r";

const STATE: ChatHostState = {
  sessionId: "help-session",
  mode: "guarded",
  model: "help-model",
  meta: {
    schemaVersion: 1,
    sessionId: "help-session",
    cwd: "/repo",
    mode: "ask",
    model: "help-model",
    bashApproval: "gated",
    title: null,
    createdAt: "now",
    updatedAt: null,
    costUsd: 0,
  },
};

const deploy: CommandResource = {
  kind: "command",
  name: "deploy",
  qualifiedName: "deploy",
  description: "Ship it",
  template: "Deploy $ARGUMENTS",
  path: "/repo/.claude/commands/deploy.md",
  origin: { kind: "claude-project" },
};

/** The catalog every case here mounts: one command and no skills. */
function oneCommandCatalog(): NonNullable<ChatHost["catalog"]> {
  return buildResourceCatalog([
    {
      id: "claude-project",
      origin: { kind: "claude-project" },
      root: "/repo",
      commands: [deploy],
      skills: [],
      agents: [],
      mcpServers: [],
      hooks: [],
      diagnostics: [],
    },
  ]);
}

/** A mounted screen over a typed fake host and the catalog the case hands it. */
function mount(catalog: NonNullable<ChatHost["catalog"]>) {
  const host: ChatHost = {
    repoRoot: "/repo",
    catalog,
    models: [STATE.model],
    asks: createChatAskController({ mode: "guarded", answer: () => {} }),
    current: () => STATE,
    notice: () => undefined,
    send: mock(async () => {}),
    cancel: mock(() => {}),
    close: mock(async () => {}),
    start: async () => {},
    clear: async () => {},
    resume: mock(async (_input: { id?: string }) => {}),
    switchTo: async () => {},
    listSessions: async () => [],
  };
  const ui = render(<ChatApp host={host} />);
  /** The frame's rows as the terminal shows them: no escape codes, no trailing blanks. */
  const rows = (): string[] =>
    Bun.stripANSI(ui.lastFrame() ?? "")
      .split("\n")
      .map((row) => row.trimEnd());
  /** Give the screen a terminal size tall enough for the whole listing. */
  const resize = async (columns: number, terminalRows: number): Promise<void> => {
    await Promise.resolve(
      act(async () => {
        Object.defineProperty(ui.stdout, "columns", { value: columns, configurable: true });
        Object.defineProperty(ui.stdout, "rows", { value: terminalRows, configurable: true });
        ui.stdout.emit("resize");
      }),
    );
  };
  /** One line typed and returned, drained through the screen's own submit path. */
  const line = async (text: string): Promise<void> => {
    await Promise.resolve(
      act(async () => {
        ui.stdin.write(text);
        ui.stdin.write(RETURN);
      }),
    );
    await Promise.resolve(
      act(async () => {
        await Promise.resolve();
      }),
    );
  };
  return { ui, host, rows, resize, line };
}

afterEach(() => {
  cleanup();
  mock.restore();
});

describe("/help with a one-command catalog", () => {
  test("AC-7 the transcript shows the singular summary and points at search", async () => {
    const ui = mount(oneCommandCatalog());
    await ui.resize(100, 50);
    await ui.line("/help");
    const frame = ui.rows().join("\n");
    expect(frame).toContain("1 command · 0 skills — type / to search");
    expect(frame).not.toContain("1 commands");
    // The command itself is never listed by `/help`: the summary stands in for it.
    expect(frame).not.toContain("/deploy");
  });
});
