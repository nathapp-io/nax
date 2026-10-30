import { describe, expect, mock, test } from "bun:test";
import { type AcpRefreshResult, type ChatHost, createChatAskController } from "@/chat";
import { NaxError } from "@/errors";
import { parseSlashCommand, runSlashCommand } from "@/tui/chat/slash-commands";

function makeHost(refreshAcpModels?: ChatHost["refreshAcpModels"]): ChatHost {
  return {
    repoRoot: "/repo",
    models: [],
    asks: createChatAskController({ mode: "guarded", answer: () => {} }),
    current: () => {
      throw new NaxError("[chat] no session", "CHAT_SESSION_NOT_OPEN", { stage: "chat" });
    },
    notice: () => undefined,
    send: async () => {},
    start: async () => {},
    clear: async () => {},
    resume: async () => {},
    switchTo: mock(async () => {}),
    cancel: () => {},
    close: async () => {},
    listSessions: async () => [],
    ...(refreshAcpModels ? { refreshAcpModels } : {}),
  };
}

async function run(host: ChatHost, line = "/model refresh") {
  const command = parseSlashCommand(line);
  if (!command) throw new Error("expected slash command");
  const shown: string[] = [];
  const outcome = await runSlashCommand(command, { host, show: (text) => shown.push(text) });
  return { shown, outcome };
}

describe("/model refresh", () => {
  test("AC-9 AC-10 prints ordered separate notes, refreshes once, never switches or opens picker", async () => {
    const results: readonly AcpRefreshResult[] = [
      { agent: "claude", outcome: "learned", models: 3 },
      { agent: "codex", outcome: "not installed" },
      { agent: "cursor", outcome: "failed", reason: "not logged in" },
    ];
    const refresh = mock(async () => results);
    const host = makeHost(refresh);
    expect(await run(host)).toEqual({
      shown: ["Claude Code: 3 models", "Codex: not installed", "Cursor: failed: not logged in"],
      outcome: undefined,
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(host.switchTo).not.toHaveBeenCalled();
  });

  test.each([undefined, async () => []])("AC-11 absent or empty refresh prints no agents", async (refresh) => {
    const host = makeHost(refresh);
    expect(await run(host)).toEqual({ shown: ["no ACP agents to refresh"], outcome: undefined });
    expect(host.switchTo).not.toHaveBeenCalled();
  });

  test.each([
    ["AC-12", 1, "1 model"],
    ["AC-13", 0, "0 models"],
  ] as const)("%s formats counts", async (_ac, models, text) => {
    const host = makeHost(async () => [{ agent: "codex", outcome: "learned", models }]);
    expect((await run(host)).shown).toEqual([`Codex: ${text}`]);
  });

  test("AC-15 lowercase refresh ignores further arguments", async () => {
    const refresh = mock(async () => []);
    const host = makeHost(refresh);
    expect((await run(host, "/model refresh extra")).outcome).toBeUndefined();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(host.switchTo).not.toHaveBeenCalled();
  });

  test.each(["Refresh", "acp:codex/m1"])("AC-15 AC-17 %s remains a model switch", async (model) => {
    const refresh = mock(async () => []);
    const host = makeHost(refresh);
    expect(await run(host, `/model ${model}`)).toEqual({ shown: [], outcome: undefined });
    expect(host.switchTo).toHaveBeenCalledWith({ model });
    expect(refresh).not.toHaveBeenCalled();
  });

  test("AC-17 no argument still returns the model picker", async () => {
    const refresh = mock(async () => []);
    const host = makeHost(refresh);
    expect((await run(host, "/model")).outcome).toEqual({ kind: "picker", picker: "model" });
    expect(refresh).not.toHaveBeenCalled();
    expect(host.switchTo).not.toHaveBeenCalled();
  });
});
