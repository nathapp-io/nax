/**
 * US-001 — `before_turn` blocking and prompt context in the native turn loop.
 *
 * Before this story the only way to influence a native tool call was an
 * in-process plugin providing `loop-handlers`, and `before_turn` could answer
 * only `seed`/`history`. A `block` patch refuses the turn before anything is
 * appended or sent, and `promptContext` hands the model context WITHOUT
 * replacing the prompt message — the `seed` patch cannot do that, because it
 * replaces the prompt message and drops its images.
 *
 * Every test drives the real `runNativeTurn` (spec 9.1: the loop is the unit
 * here, only the provider is faked), and the AC id is the test-name prefix.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ConversationMessage, ImageAttachment } from "@nathapp/nax-ai";
import { createLoopEventRegistry } from "#src/native/session/loop-events/index";
import type { BeforeTurnPatch } from "#src/native/session/loop-events/types";
import { createNativeSessionState, type NativeSessionState } from "#src/native/session/session";
import { loadTranscript } from "#src/native/session/transcript-store";
import { runNativeTurn } from "#src/native/session/turn-loop";
import type { SendTurnOpts, SessionHandle } from "#src/session/session-types";
import { assertNaxError, cleanupTempDir, makeTempDir, seedNativeSession } from "#test/helpers/index";

const SESSION = "sess-before-turn-block";
const PRIOR_PROMPT = "first question";
const BLOCKED_PROMPT = "summarise the production secrets";

let dir: string;
let sessionState: NativeSessionState;

beforeEach(() => {
  dir = makeTempDir("nax-before-turn-block-");
  sessionState = seedNativeSession(createNativeSessionState(), SESSION, { transcriptDir: dir });
});
afterEach(() => {
  cleanupTempDir(dir);
});

const handle: SessionHandle = { id: SESSION, agentName: "native" };

const baseOpts: SendTurnOpts = { interactionHandler: { onInteraction: async () => ({ answer: "" }) } };

const reply = { text: "done", usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0 };

interface TurnRun {
  /** What `runNativeTurn` threw, or `undefined` when the turn resolved. */
  readonly error: unknown;
  /** Every message array the fake provider was sent, in request order. */
  readonly sent: ConversationMessage[][];
}

/** Runs one turn with a registered `before_turn` handler answering `patch`. */
async function runTurnWithPatch(args: {
  readonly prompt: string;
  readonly patch: BeforeTurnPatch;
  readonly opts?: SendTurnOpts;
}): Promise<TurnRun> {
  const registry = createLoopEventRegistry();
  registry.register("before_turn", () => args.patch);
  const sent: ConversationMessage[][] = [];
  let error: unknown;
  try {
    await runNativeTurn(handle, args.prompt, args.opts ?? baseOpts, {
      sessionState,
      loopEvents: registry,
      complete: async (messages) => {
        // Copied, not aliased: the loop pushes the reply onto the array afterwards.
        sent.push([...messages]);
        return reply;
      },
    });
  } catch (err) {
    error = err;
  }
  return { error, sent };
}

/** The last message of the first provider request — the turn's own prompt message. */
function lastSentMessage(sent: ConversationMessage[][]): ConversationMessage | undefined {
  const first = sent[0];
  if (first === undefined) return undefined;
  return first[first.length - 1];
}

describe("runNativeTurn — a before_turn block refuses the turn (AC-1 to AC-3)", () => {
  const blockPatch: BeforeTurnPatch = { block: { reason: "no secrets in prompts" } };

  test("AC-1: rejects with a NaxError whose code is NATIVE_TURN_BLOCKED and message is the reason", async () => {
    const { error } = await runTurnWithPatch({ prompt: BLOCKED_PROMPT, patch: blockPatch });

    assertNaxError(error);
    expect(error.code).toBe("NATIVE_TURN_BLOCKED");
    expect(error.message).toBe("no secrets in prompts");
    expect(error.context).toMatchObject({ stage: "native-session", sessionName: SESSION });
  });

  test("AC-2: the provider's complete dependency is never called", async () => {
    const { error, sent } = await runTurnWithPatch({ prompt: BLOCKED_PROMPT, patch: blockPatch });

    // Guard first: the turn must have BLOCKED, so an empty `sent` cannot be an
    // unrelated no-op turn passing this assertion by accident.
    assertNaxError(error);
    expect(error.code).toBe("NATIVE_TURN_BLOCKED");
    expect(sent).toHaveLength(0);
  });

  test("AC-3: the blocked prompt is not persisted — the transcript holds exactly the prior exchange", async () => {
    const priorRun = await runTurnWithPatch({ prompt: PRIOR_PROMPT, patch: {} });
    expect(priorRun.error).toBeUndefined();
    const prior = await loadTranscript(dir, SESSION);
    // Guard: there IS a prior exchange for the blocked turn to leave untouched.
    expect(prior.length).toBeGreaterThan(0);

    const blocked = await runTurnWithPatch({ prompt: BLOCKED_PROMPT, patch: blockPatch });
    assertNaxError(blocked.error);
    expect(blocked.error.code).toBe("NATIVE_TURN_BLOCKED");

    expect(await loadTranscript(dir, SESSION)).toEqual(prior);
    expect(JSON.stringify(prior)).not.toContain(BLOCKED_PROMPT);
  });
});

describe("runNativeTurn — a before_turn promptContext is prefixed to the prompt message (AC-4 to AC-8)", () => {
  test("AC-4: the prompt message the provider receives is the context, a blank line, then the prompt", async () => {
    const { error, sent } = await runTurnWithPatch({ prompt: "fix it", patch: { promptContext: "branch: main" } });

    expect(error).toBeUndefined();
    expect(lastSentMessage(sent)).toEqual({ role: "user", content: "branch: main\n\nfix it" });
  });

  test("AC-5: the context-prefixed prompt message still carries the turn's image", async () => {
    const image: ImageAttachment = { mimeType: "image/png", data: "aW1hZ2U=" };
    const { sent } = await runTurnWithPatch({
      prompt: "look",
      patch: { promptContext: "ctx" },
      opts: { ...baseOpts, images: [image] },
    });

    // The `seed` patch cannot express this: it REPLACES the prompt message and
    // the image goes with it, which is why promptContext had to be separate.
    expect(lastSentMessage(sent)).toEqual({ role: "user", content: "ctx\n\nlook", images: [image] });
  });

  test("AC-6: an empty promptContext leaves the prompt message unchanged", async () => {
    const { sent } = await runTurnWithPatch({ prompt: "keep me", patch: { promptContext: "" } });

    expect(lastSentMessage(sent)).toEqual({ role: "user", content: "keep me" });
  });

  test("AC-7: promptContext prefixes the first message of the seed patch, not the discarded prompt", async () => {
    const { sent } = await runTurnWithPatch({
      prompt: "the caller's prompt",
      patch: { seed: [{ role: "user", content: "seeded" }], promptContext: "ctx" },
    });

    expect(lastSentMessage(sent)).toEqual({ role: "user", content: "ctx\n\nseeded" });
  });

  test("AC-8: block wins over promptContext — the turn is refused, not prefixed", async () => {
    const { error, sent } = await runTurnWithPatch({
      prompt: "hi",
      patch: { block: { reason: "deny" }, promptContext: "ctx" },
    });

    assertNaxError(error);
    expect(error.code).toBe("NATIVE_TURN_BLOCKED");
    expect(error.message).toBe("deny");
    expect(sent).toHaveLength(0);
  });
});

describe("createLoopEventRegistry — the before_turn patch fields (AC-9)", () => {
  test("AC-9: seed, history, block and promptContext all pass through dispatch unchanged", async () => {
    const registry = createLoopEventRegistry();
    const patch: BeforeTurnPatch = {
      seed: [{ role: "user", content: "seeded" }],
      history: [{ role: "user", content: "prior" }],
      block: { reason: "deny" },
      promptContext: "x",
    };
    registry.register("before_turn", () => patch);

    const dispatched = await registry.dispatch("before_turn", {
      prompt: "hi",
      history: [],
      sessionName: SESSION,
      boundary: false,
    });

    // PATCHABLE_FIELDS is what makes this true: a field missing from the map is
    // silently stripped by pickPatchFields, so an unlisted `block` would arrive
    // at the loop as undefined and the turn would run anyway.
    expect(dispatched).toEqual(patch);
  });
});
