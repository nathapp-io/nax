/**
 * US-011 AC-1/AC-2: `/image [path]` is a builtin whose outcome is the new `attach` one.
 *
 * The command reads nothing itself — it answers with the path the user typed (or with no
 * path at all, which the screen reads as the clipboard flow) and lets the screen's attach
 * hook do the reading. It is a builtin without an ACP-owned feature, so an ACP brain runs it
 * as a native one does, which is why the ACP case here expects the same outcome rather than
 * a "not available" notice.
 */
import { describe, expect, test } from "bun:test";
import { type ChatHost, type ChatHostState, createChatAskController } from "@/chat";
import { parseSlashCommand, runSlashCommand } from "@/tui/chat/slash-commands";

const NATIVE_MODEL = "openai/gpt-6";
const ACP_MODEL = "acp:codex";

function stateOf(model: string): ChatHostState {
  return {
    sessionId: "image-command-session",
    mode: "guarded",
    model,
    meta: {
      schemaVersion: 1,
      sessionId: "image-command-session",
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

function makeHost(model: string): ChatHost {
  return {
    repoRoot: "/repo",
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

describe("runSlashCommand for /image", () => {
  test("AC-1 returns an attach outcome, with the typed path when there is one", async () => {
    const host = makeHost(NATIVE_MODEL);
    expect(await run(host, "/image")).toEqual({ outcome: { kind: "attach" }, shown: [] });
    expect(await run(host, "/image shots/a b.png")).toEqual({
      outcome: { kind: "attach", path: "shots/a b.png" },
      shown: [],
    });
  });

  test("AC-2 an ACP brain hands the same outcome over rather than refusing", async () => {
    expect(await run(makeHost(ACP_MODEL), "/image")).toEqual({ outcome: { kind: "attach" }, shown: [] });
  });
});
