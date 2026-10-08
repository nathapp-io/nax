import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLoopEventRegistry } from "#src/native/session/loop-events/index";
import { createNativeSessionState, type NativeSessionState } from "#src/native/session/session";
import { runNativeTurn } from "#src/native/session/turn-loop";
import type { SendTurnOpts } from "#src/session/session-types";
import { seedNativeSession } from "#test/helpers/index";

let dir: string;
let sessionState: NativeSessionState;
const handle = { id: "sess-after-response", agentName: "native" } as const;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nax-after-response-"));
  sessionState = seedNativeSession(createNativeSessionState(), "sess-after-response", { transcriptDir: dir });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const usage = { inputTokens: 1, outputTokens: 1 };
const opts = (over: Partial<SendTurnOpts> = {}): SendTurnOpts => ({
  interactionHandler: { onInteraction: async () => ({ answer: "tool said hi" }) },
  ...over,
});

describe("native turn loop — after_response event", () => {
  test("a text patch reaches TurnResult.output, not only the transcript", async () => {
    const registry = createLoopEventRegistry();
    registry.register("after_response", () => ({ text: "patched answer" }));

    const result = await runNativeTurn(handle, "hi", opts(), {
      sessionState,
      loopEvents: registry,
      complete: async () => ({ text: "raw model answer", usage, costUsd: 0 }),
    });

    expect(result.output).toBe("patched answer");
  });

  test("without a patch the output is the model's text", async () => {
    const result = await runNativeTurn(handle, "hi", opts(), {
      sessionState,
      loopEvents: createLoopEventRegistry(),
      complete: async () => ({ text: "raw model answer", usage, costUsd: 0 }),
    });

    expect(result.output).toBe("raw model answer");
  });
});
