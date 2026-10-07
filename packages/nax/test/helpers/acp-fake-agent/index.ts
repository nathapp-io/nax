/**
 * Test doubles for the ACP SDK adapter (S4b-2 D2-e).
 *
 * The fake ACP agent is nax-agent-acp's own (packages/nax-agent-acp/test/fixtures/
 * fake-agent), run as a subprocess. It is reached by file path, never imported:
 * nax may import nax-agent-acp only through ./client. The script is JSON in
 * FAKE_AGENT_SCRIPT (see that package's script.ts for the shape); every request
 * the agent receives is appended to FAKE_AGENT_RECORD.
 *
 * scriptedOpened() is an in-memory OpenedBackend for the turn loop's unit tests.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AgentSessionAdapter,
  attachTurnSpend,
  NO_OP_INTERACTION_HANDLER,
  type OpenedBackend,
  type SendTurnOpts,
  type SessionBackend,
  type TurnResult,
} from "@nathapp/nax-agent";
import { type AcpBackendOptions, acpBackend } from "@nathapp/nax-agent-acp/client";

export const FAKE_ACP_AGENT_MAIN = join(import.meta.dir, "../../../../nax-agent-acp/test/fixtures/fake-agent/main.ts");

/** Claude's config as the fake offers it (fake-agent/script.ts CLAUDE_CONFIG_OPTIONS, plus haiku and opus). */
export const FAKE_CLAUDE_CONFIG_OPTIONS = [
  {
    id: "mode",
    name: "Mode",
    category: "mode",
    type: "select",
    currentValue: "default",
    options: [
      { value: "default", name: "Default" },
      { value: "acceptEdits", name: "Accept edits" },
      { value: "plan", name: "Plan" },
    ],
  },
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "default",
    options: [
      { value: "default", name: "Default" },
      { value: "sonnet", name: "Sonnet" },
      { value: "haiku", name: "Haiku" },
      { value: "opus", name: "Opus" },
    ],
  },
];

/** acpBackend with the registered agent's launch replaced by the fake; its registry entry still applies. */
export function fakeAcpBackend(
  script: Record<string, unknown>,
  recordPath: string,
): (options: AcpBackendOptions) => SessionBackend {
  const scriptJson = JSON.stringify({ configOptions: FAKE_CLAUDE_CONFIG_OPTIONS, ...script });
  return (options) =>
    acpBackend({
      ...options,
      command: process.execPath,
      args: [FAKE_ACP_AGENT_MAIN],
      env: { ...options.env, FAKE_AGENT_SCRIPT: scriptJson, FAKE_AGENT_RECORD: recordPath },
    });
}

export interface FakeRecord {
  readonly method: string;
  readonly params: unknown;
}

/** Narrows a parsed record line without a cast: a record has a string `method`. */
function fakeRecordOf(value: unknown): FakeRecord | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const method: unknown = Reflect.get(value, "method");
  return typeof method === "string" ? { method, params: Reflect.get(value, "params") } : undefined;
}

export function readFakeRecords(path: string): FakeRecord[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => fakeRecordOf(JSON.parse(line)))
    .filter((record): record is FakeRecord => record !== undefined);
}

export function fakeMethods(path: string): string[] {
  return readFakeRecords(path).map((record) => record.method);
}

/** The pid of every agent process launched against this record file, in order. */
export function fakeStartPids(path: string): number[] {
  return readFakeRecords(path)
    .filter((record) => record.method === "start")
    .map((record) => {
      const params = record.params;
      return typeof params === "object" && params !== null && "pid" in params && typeof params.pid === "number"
        ? params.pid
        : -1;
    });
}

export type ScriptedTurn = (prompt: string, opts: SendTurnOpts) => Promise<TurnResult>;

export interface SpendStub {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
}

const DEFAULT_SPEND: SpendStub = { inputTokens: 10, outputTokens: 5, costUsd: 0.01 };

/** A backend prompt that ends end_turn with `output` and a reported cost. */
export function replyTurn(output: string, spend: SpendStub = DEFAULT_SPEND): ScriptedTurn {
  return async () => ({
    output,
    tokenUsage: { inputTokens: spend.inputTokens, outputTokens: spend.outputTokens },
    estimatedCostUsd: spend.costUsd,
    costSource: "reported",
    internalRoundTrips: 1,
  });
}

function attach(err: object, spend: SpendStub): void {
  attachTurnSpend(err, {
    tokenUsage: { inputTokens: spend.inputTokens, outputTokens: spend.outputTokens },
    costUsd: spend.costUsd,
    costSource: "reported",
  });
}

/** Runs until the prompt's signal aborts, then throws the signal's reason with the spend attached (as the backend does). */
export function hangTurn(spend: SpendStub = DEFAULT_SPEND): ScriptedTurn {
  return (_prompt, opts) =>
    new Promise((_resolve, reject) => {
      const signal = opts.signal;
      if (signal === undefined) return;
      const fail = (): void => {
        const reason: unknown = signal.reason;
        const err = reason instanceof Error ? reason : new Error("aborted");
        attach(err, spend);
        reject(err);
      };
      if (signal.aborted) fail();
      else signal.addEventListener("abort", fail, { once: true });
    });
}

/** A backend prompt that fails with `err`, spend attached. */
export function failTurn(err: Error, spend: SpendStub = DEFAULT_SPEND): ScriptedTurn {
  return async () => {
    attach(err, spend);
    throw err;
  };
}

export interface ScriptedOpened {
  readonly opened: OpenedBackend;
  /** The prompts sent, in order. */
  readonly prompts: string[];
  /** The SendTurnOpts each prompt was sent with. */
  readonly sent: SendTurnOpts[];
  closeCount(): number;
}

/** An in-memory OpenedBackend running `turns` in order; the last one repeats. */
export function scriptedOpened(turns: readonly ScriptedTurn[]): ScriptedOpened {
  const prompts: string[] = [];
  const sent: SendTurnOpts[] = [];
  let closes = 0;
  let next = 0;
  const handle = { id: "backend-handle", agentName: "acp:claude" };
  const adapter: AgentSessionAdapter = {
    openSession: async () => handle,
    sendTurn: (_handle, prompt, opts) => {
      prompts.push(prompt);
      sent.push(opts);
      const turn = turns[Math.min(next, turns.length - 1)];
      next++;
      if (turn === undefined) return Promise.reject(new Error("scriptedOpened: no turns"));
      return turn(prompt, opts);
    },
    closeSession: async () => {},
  };
  const opened: OpenedBackend = {
    adapter,
    handle,
    info: { kind: "acp:claude", capabilities: {} },
    turnOpts: () => ({ interactionHandler: NO_OP_INTERACTION_HANDLER }),
    close: async () => {
      closes++;
    },
  };
  return { opened, prompts, sent, closeCount: () => closes };
}
