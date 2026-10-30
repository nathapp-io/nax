/**
 * US-012 AC-16: the screen's slash menu follows the session's current model, so switching the
 * brain from a native model to an ACP agent drops the catalog's skills from the menu.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import { act } from "react";
import { type ChatHost, type ChatHostState, createChatAskController } from "@/chat";
import { buildResourceCatalog } from "@/resources";
import { ChatApp } from "@/tui/chat";

afterEach(() => {
  cleanup();
});

const ORIGIN = { kind: "nax-plugin", plugin: "kit" } as const;
const SKILL_ROW = "(skill) literal";
const CTRL_U = "\x15";

async function typeText(press: (text: string) => Promise<void>, text: string): Promise<void> {
  for (const char of text) await press(char);
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
    },
  };
}

function mount() {
  let state = stateOf("openai/gpt-6");
  const catalog = buildResourceCatalog([
    {
      id: "kit",
      root: "/kit",
      origin: ORIGIN,
      agents: [],
      mcpServers: [],
      hooks: [],
      diagnostics: [],
      commands: [],
      skills: [
        {
          kind: "skill",
          name: "zebra",
          qualifiedName: "kit:zebra",
          description: "literal",
          body: "body",
          baseDir: "/kit/zebra",
          path: "/kit/zebra/SKILL.md",
          modelInvocable: true,
          origin: ORIGIN,
        },
      ],
    },
  ]);
  const host: ChatHost = {
    repoRoot: "/repo",
    catalog,
    models: ["openai/gpt-6", "acp:codex"],
    asks: createChatAskController({ mode: "guarded", answer: () => {} }),
    current: () => state,
    notice: () => undefined,
    send: async () => {},
    start: async () => {},
    clear: async () => {},
    resume: async () => {},
    switchTo: async (input) => {
      if (input.model !== undefined) state = stateOf(input.model);
    },
    cancel: () => {},
    close: async () => {},
    listSessions: async () => [],
  };
  const ui = render(<ChatApp host={host} />);
  const press = async (text: string): Promise<void> => {
    await Promise.resolve(
      act(async () => {
        ui.stdin.write(text);
      }),
    );
  };
  const frame = (): string => Bun.stripANSI(ui.lastFrame() ?? "");
  return { ui, press, frame };
}

describe("ChatApp slash menu follows the current model", () => {
  test("AC-16 lists the catalog skill on a native brain and none after switching to ACP", async () => {
    const { press, frame } = mount();
    await typeText(press, "/zebra");
    expect(frame()).toContain(SKILL_ROW);

    // Clear the line, then switch the brain through the screen's own /model command.
    await press(CTRL_U);
    await typeText(press, "/model acp:codex");
    await press("\r");
    await press("");
    expect(frame()).toContain("※ model: Codex");

    await typeText(press, "/zebra");
    expect(frame()).not.toContain(SKILL_ROW);
    await press(CTRL_U);
    await press("/");
    expect(frame()).toContain("/help");
  });
});
