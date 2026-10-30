import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { TranscriptDoc, TranscriptStore } from "@nathapp/nax-agent";
import type { ChatMessage } from "@/chat/acp/acp-history";
import { appendNativeTurn } from "@/chat/acp/acp-transcript-append";
import { getLogger } from "@/logger";

const u: ChatMessage = { role: "user", content: "hi" };
const a: ChatMessage = {
  role: "assistant",
  content: "hello",
  origin: { provider: "acp:codex", model: "gpt-5.5" },
};
const m1: ChatMessage = { role: "user", content: "earlier" };

const NOW = new Date("2026-10-01T12:00:00.000Z");

const STORED: TranscriptDoc = {
  savedAt: "2026-01-01T00:00:00.000Z",
  messages: [m1],
  model: "gpt-5.5",
  owner: "brain-1",
  turn: { turnId: "t1", state: "ended" },
  instructionSources: [{ path: "AGENTS.md", scope: "repo", hash: "abc" }],
};

function untouchable(method: string): never {
  throw new Error(`appendNativeTurn must not call store.${method}`);
}

function harness(
  options: {
    readonly load?: () => Promise<TranscriptDoc | null>;
    readonly save?: (sessionId: string, doc: TranscriptDoc) => Promise<void>;
  } = {},
) {
  const save = mock(async (sessionId: string, doc: TranscriptDoc): Promise<void> => {
    await options.save?.(sessionId, doc);
  });
  const store: TranscriptStore = {
    load: options.load ?? (async () => null),
    save,
    retainFailed: () => untouchable("retainFailed"),
    delete: () => untouchable("delete"),
    markTurn: () => untouchable("markTurn"),
  };
  return { store, save };
}

/** The document the store was asked to save. */
function savedDoc(save: { mock: { calls: Array<[string, TranscriptDoc]> } }): TranscriptDoc {
  const [call] = save.mock.calls;
  if (call === undefined) throw new Error("expected store.save to be called");
  return call[1];
}

interface WarnCall {
  readonly stage: string;
  readonly message: string;
  readonly data: Record<string, unknown> | undefined;
}

interface WarnCapture {
  readonly calls: WarnCall[];
  readonly restore: () => void;
}

function captureWarn(): WarnCapture {
  const calls: WarnCall[] = [];
  const spy = spyOn(getLogger(), "warn").mockImplementation(
    (stage: string, message: string, data?: Record<string, unknown>) => {
      calls.push({ stage, message, data });
    },
  );
  return { calls, restore: () => spy.mockRestore() };
}

describe("appendNativeTurn", () => {
  describe("with no stored document", () => {
    test("AC-1: saves a document with exactly savedAt and messages", async () => {
      const { store, save } = harness();
      await appendNativeTurn(store, "s1", [u, a], () => NOW);
      expect(Object.keys(savedDoc(save)).sort()).toEqual(["messages", "savedAt"]);
    });

    test("AC-2: saves the messages it was given", async () => {
      const { store, save } = harness();
      await appendNativeTurn(store, "s1", [u, a], () => NOW);
      expect(savedDoc(save).messages).toEqual([u, a]);
    });

    test("AC-3: saves the injected now() as an ISO string in savedAt", async () => {
      const { store, save } = harness();
      await appendNativeTurn(store, "s1", [u, a], () => NOW);
      expect(savedDoc(save).savedAt).toBe(NOW.toISOString());
    });
  });

  describe("with a stored document", () => {
    const loaded = () => harness({ load: async () => STORED });

    test("AC-4: appends to the stored messages", async () => {
      const { store, save } = loaded();
      await appendNativeTurn(store, "s1", [u, a], () => NOW);
      expect(savedDoc(save).messages).toEqual([m1, u, a]);
    });

    test("AC-5: keeps the stored model", async () => {
      const { store, save } = loaded();
      await appendNativeTurn(store, "s1", [u, a], () => NOW);
      expect(savedDoc(save).model).toBe(STORED.model);
    });

    test("AC-6: keeps the stored owner", async () => {
      const { store, save } = loaded();
      await appendNativeTurn(store, "s1", [u, a], () => NOW);
      expect(savedDoc(save).owner).toBe(STORED.owner);
    });

    test("AC-7: keeps the stored turn", async () => {
      const { store, save } = loaded();
      await appendNativeTurn(store, "s1", [u, a], () => NOW);
      expect(savedDoc(save).turn).toEqual(STORED.turn);
    });

    test("AC-8: keeps the stored instructionSources", async () => {
      const { store, save } = loaded();
      await appendNativeTurn(store, "s1", [u, a], () => NOW);
      expect(savedDoc(save).instructionSources).toEqual(STORED.instructionSources);
    });
  });

  test("AC-9: saves once, under the session id", async () => {
    const { store, save } = harness({ load: async () => STORED });
    await appendNativeTurn(store, "s1", [u, a], () => NOW);
    expect(save.mock.calls.length).toBe(1);
    const [call] = save.mock.calls;
    expect(call?.[0]).toBe("s1");
  });

  describe("failure handling", () => {
    const failingSave = () => harness({ save: () => Promise.reject(new Error("disk full")) });
    const failingLoad = () => harness({ load: () => Promise.reject(new Error("unreadable")) });

    let warn: WarnCapture;
    beforeEach(() => {
      warn = captureWarn();
    });
    afterEach(() => {
      warn.restore();
    });

    test("AC-10: resolves when the save rejects", async () => {
      const { store } = failingSave();
      await expect(appendNativeTurn(store, "s1", [u, a], () => NOW)).resolves.toBeUndefined();
    });

    test("AC-11: warns with the session id when the save rejects", async () => {
      const { store } = failingSave();
      await appendNativeTurn(store, "s1", [u, a], () => NOW);
      expect(warn.calls.length).toBe(1);
      expect(warn.calls[0]?.stage).toBe("chat");
      expect(warn.calls[0]?.message).toBe("could not record the ACP turn");
      expect(warn.calls[0]?.data?.sessionId).toBe("s1");
    });

    test("AC-12: resolves without saving when the load rejects", async () => {
      const { store, save } = failingLoad();
      await expect(appendNativeTurn(store, "s1", [u, a], () => NOW)).resolves.toBeUndefined();
      expect(save.mock.calls.length).toBe(0);
    });

    test("AC-13: warns with the session id when the load rejects", async () => {
      const { store } = failingLoad();
      await appendNativeTurn(store, "s1", [u, a], () => NOW);
      expect(warn.calls.length).toBe(1);
      expect(warn.calls[0]?.stage).toBe("chat");
      expect(warn.calls[0]?.message).toBe("could not record the ACP turn");
      expect(warn.calls[0]?.data?.sessionId).toBe("s1");
    });

    test.each([
      ["load", failingLoad, "unreadable"],
      ["save", failingSave, "disk full"],
    ] as const)("AC-14: reports the %s rejection through errorMessage", async (_leg, failing, message) => {
      const { store } = failing();
      await appendNativeTurn(store, "s1", [u, a], () => NOW);
      expect(warn.calls[0]?.data?.error).toBe(message);
    });
  });
});
