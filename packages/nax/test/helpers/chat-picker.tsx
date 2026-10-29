import { mock } from "bun:test";
import type { SessionEvent, SessionEventBody } from "@nathapp/nax-agent";
import { render } from "ink-testing-library";
import { act } from "react";
import { type ChatHost, type ChatHostState, type ChatSessionRow, createChatAskController } from "@/chat";
import { ChatApp } from "@/tui/chat";

const MODELS = ["model-a", "model-b", "model-c"] as const;
const RETURN = "\r";
const RULE = "─";
const POINTER = "❯";
const POINTER_COLUMNS = 2;
const COLUMN_GAP = "  ";
/** The session the screen reports, with the model and mode a case cares about. */
function chatState(current: Partial<ChatHostState> = {}): ChatHostState {
  const model = current.model ?? MODELS[0];
  return {
    sessionId: "picker-session",
    mode: "guarded",
    model,
    meta: {
      schemaVersion: 1,
      sessionId: "picker-session",
      cwd: "/repo",
      mode: "ask",
      model,
      bashApproval: "gated",
      title: null,
      createdAt: "now",
      updatedAt: null,
      costUsd: 0,
    },
    ...current,
  };
}

interface MountOptions {
  readonly models?: readonly string[];
  readonly effortLevels?: ChatHost["effortLevels"];
  readonly current?: Partial<ChatHostState>;
  /** Absent: `listSessions()` resolves to no rows at once. */
  readonly sessions?: () => Promise<readonly ChatSessionRow[]>;
  /** Absent: every host action succeeds at once. */
  readonly switchTo?: ChatHost["switchTo"];
  readonly resume?: ChatHost["resume"];
  /**
   * A host the case builds itself — a real one over a real session store. The fake below,
   * and the mocks returned with it, are then created and unused: what the case observes is
   * the host's own effects, not a call recorded here.
   */
  readonly host?: ChatHost;
}

/**
 * The mounted screen over a typed fake host. Every host action the picker can name is a
 * mock, so the assertion after a choice is about the call it made, and `listSessions` is
 * whatever the case supplies — a deferred promise where `loading…` has to be observed.
 */
export function mount(options: MountOptions = {}) {
  const current = chatState(options.current);
  const switchTo = mock<ChatHost["switchTo"]>(options.switchTo ?? (async () => {}));
  const resume = mock<ChatHost["resume"]>(options.resume ?? (async () => {}));
  const listSessions = mock<ChatHost["listSessions"]>(options.sessions ?? (async () => []));
  /** A turn's listener, and the gate that keeps its stream open until `finish()`. */
  const gate = Promise.withResolvers<void>();
  let onEvent: (event: SessionEvent) => void = () => {};
  const send = mock<ChatHost["send"]>(async (_message: string, listener: (event: SessionEvent) => void) => {
    onEvent = listener;
    await gate.promise;
  });
  const fake: ChatHost = {
    repoRoot: "/repo",
    models: options.models ?? MODELS,
    ...(options.effortLevels === undefined ? {} : { effortLevels: options.effortLevels }),
    asks: createChatAskController({ mode: "guarded", answer: () => {} }),
    current: () => current,
    notice: () => undefined,
    send,
    cancel: mock(() => {}),
    close: mock(async () => {}),
    start: async () => {},
    clear: async () => {},
    resume,
    switchTo,
    listSessions,
  };
  const host = options.host ?? fake;
  const ui = render(<ChatApp host={host} />);
  /** The frame's rows as the terminal shows them: no escape codes, no trailing blanks. */
  const rows = (): string[] =>
    Bun.stripANSI(ui.lastFrame() ?? "")
      .split("\n")
      .map((row) => row.trimEnd());
  /** One keypress, in its own act, so the frame read afterwards is the frame it produced. */
  const press = (sequence: string): void =>
    act(() => {
      ui.stdin.write(sequence);
    });
  /** A line typed a keypress at a time, then the return that submits it. */
  const submit = async (text: string): Promise<void> => {
    for (const char of text) press(char);
    await Promise.resolve(
      act(async () => {
        ui.stdin.write(RETURN);
      }),
    );
  };
  /** Let a promise the screen is waiting on settle, and the frame that follows it. */
  const settle = (): Promise<void> =>
    Promise.resolve(
      act(async () => {
        await Promise.resolve();
      }),
    );
  /** Settle a promise the screen holds, inside the act that redraws after it. */
  const settleAfter = (action: () => void): Promise<void> =>
    Promise.resolve(
      act(async () => {
        action();
      }),
    );
  /** One session event from the turn the scripted send opened. */
  const emit = (body: SessionEventBody): void =>
    act(() => {
      onEvent({ sessionId: "picker-session", turnId: "t1", at: "now", metadata: {}, ...body });
    });
  /** End the scripted turn's stream, so the screen is idle again. */
  const finish = (): Promise<void> =>
    Promise.resolve(
      act(async () => {
        gate.resolve();
      }),
    );
  return { ui, host, switchTo, resume, listSessions, rows, press, submit, settle, settleAfter, emit, finish };
}

/**
 * The picker's rows: the rules bound them and the title names the top of them. The header's
 * own rule and the input's are not one of them — the list sits between the two rules below
 * the title, which is why the title is what locates the frame.
 */
export function frameOf(rows: readonly string[], title: string): { top: string; inside: string[]; bottom: string } {
  const at = rows.indexOf(title);
  if (at < 1) return { top: "", inside: [], bottom: "" };
  const rest = rows.slice(at + 1);
  const end = rest.findIndex((row) => row.startsWith(RULE));
  return { top: rows[at - 1] ?? "", inside: rest.slice(0, end < 0 ? rest.length : end), bottom: rest[end] ?? "" };
}

/** The picker's entry rows: every row inside the frame that starts with the pointer or its blank. */
export function entryRows(inside: readonly string[]): string[] {
  return inside.filter((row) => row.startsWith(POINTER) || row.startsWith(" ".repeat(POINTER_COLUMNS)));
}

/** A row's label: the pointer's columns off, and everything from the column gap after it. */
export function labelOf(row: string): string {
  return row.slice(POINTER_COLUMNS).split(COLUMN_GAP)[0] ?? "";
}
