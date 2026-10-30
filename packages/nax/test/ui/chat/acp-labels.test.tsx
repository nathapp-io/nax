/**
 * US-011 AC-9..AC-15: the model picker names an unavailable ACP agent through the host's
 * `modelNote`, and a model change that changes the brain says the new brain cannot see the
 * old brain's turns.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createSessionStorage, type SessionMeta } from "@nathapp/nax-agent";
import {
  cleanupTempDir,
  pickerEntryRows as entryRows,
  pickerFrameOf as frameOf,
  makeLogger,
  makeNaxConfig,
  makeTempDir,
  mountChatPicker as mount,
} from "@test/helpers";
import { cleanup, render } from "ink-testing-library";
import { act } from "react";
import { type ChatHost, type ChatHostDeps, type ChatHostState, createChatHost } from "@/chat";
import { _acpCatalogDeps, createAcpCatalog } from "@/chat/acp";
import type { TranscriptEntry } from "@/tui/chat/transcript-model";
import { useSwitchNotices } from "@/tui/chat/use-switch-notices";

const NOW = new Date("2026-10-01T00:00:00.000Z");
const originalProbe = _acpCatalogDeps.launchCandidateKind;

let dir: string;
let host: ChatHost | undefined;

beforeEach(() => {
  dir = makeTempDir("acp-labels-");
});
afterEach(async () => {
  cleanup();
  _acpCatalogDeps.launchCandidateKind = originalProbe;
  await host?.close();
  host = undefined;
  cleanupTempDir(dir);
});

describe("US-011 AC-9 picker through useChatPicker over a real host", () => {
  test("draws unavailable: not installed on the row of an agent whose binary is missing", async () => {
    _acpCatalogDeps.launchCandidateKind = (agent) => (agent === "cursor" ? undefined : "local");
    const meta: SessionMeta = {
      schemaVersion: 1,
      sessionId: "s1",
      cwd: dir,
      mode: "ask",
      model: "test-model",
      bashApproval: "gated",
      title: null,
      createdAt: NOW.toISOString(),
      updatedAt: null,
      costUsd: 0,
    };
    const open: ChatHostDeps["open"] = async () => ({
      meta,
      release: async () => {},
      session: {
        id: "s1",
        backend: { kind: "native", capabilities: {} },
        async *send() {},
        answer: () => "unknown",
        cancel: () => {},
        close: async () => {},
        lastTurn: undefined,
      },
    });
    host = createChatHost({
      acp: createAcpCatalog({ env: {} }),
      config: makeNaxConfig({ outputDir: join(dir, "output") }),
      cwd: dir,
      repoRoot: dir,
      chain: null,
      storage: createSessionStorage({
        dir: join(dir, "sessions"),
        pid: process.pid,
        now: () => NOW,
        logger: makeLogger(),
        isAlive: () => true,
      }),
      now: () => NOW,
      logger: makeLogger(),
      open,
    });
    await host.start({ mode: "guarded", model: "test-model" });
    const ui = mount({ host });
    await ui.submit("/model");
    const rows = entryRows(frameOf(ui.rows(), "Switch model").inside);
    expect(rows.some((row) => row.includes("Cursor") && row.includes("unavailable: not installed"))).toBe(true);
    expect(rows.filter((row) => row.includes("unavailable:"))).toHaveLength(1);
  });
});

function stateWith(model: string): ChatHostState {
  return {
    sessionId: "s1",
    mode: "guarded",
    model,
    meta: {
      schemaVersion: 1,
      sessionId: "s1",
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

/** The notice texts appended when the model changes from `from` to `to` on the same session. */
function noticesFor(from: string, to: string): string[] {
  const texts: string[] = [];
  const append = (entry: TranscriptEntry): void => {
    if (entry.kind === "notice") texts.push(entry.text);
  };
  function Harness({ state }: { state: ChatHostState }) {
    useSwitchNotices(state, append);
    return null;
  }
  const ui = render(<Harness state={stateWith(from)} />);
  act(() => ui.rerender(<Harness state={stateWith(to)} />));
  return texts;
}

describe("US-011 useSwitchNotices brain changes", () => {
  test.each([
    ["AC-10 native to ACP", "openai/gpt-6", "acp:codex", ["model: Codex"]],
    ["AC-11 same agent, new model", "acp:codex", "acp:codex/gpt-5.4", ["model: Codex · gpt-5.4"]],
    ["AC-12 same agent, new effort", "acp:codex", "acp:codex[high]", ["model: Codex[high]"]],
    ["AC-13 ACP to native", "acp:codex", "openai/gpt-6[high]", ["model: gpt-6[high]"]],
    ["AC-14 one agent to another", "acp:codex", "acp:claude", ["model: Claude Code"]],
    ["AC-15 native effort change", "openai/gpt-6", "openai/gpt-6[high]", ["model: gpt-6[high]"]],
  ])("%s", (_name, from, to, expected) => {
    expect(noticesFor(from, to)).toEqual(expected);
  });
});
