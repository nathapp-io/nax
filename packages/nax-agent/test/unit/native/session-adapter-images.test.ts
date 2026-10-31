import { afterEach, describe, expect, test } from "bun:test";
import type { ImageAttachment, SendTurnOpts } from "@nathapp/nax-agent";
import { NaxError } from "#src/infra/index";
import { createLoopEventRegistry } from "#src/native/session/loop-events/index";
import { createMemoryTranscriptStore } from "#src/native/session/memory-transcript-store";
import { NativeSessionAdapter } from "#src/native/session-adapter";
import { cleanupTempDir, installImageClient, makeTempDir } from "#test/helpers/index";

const img: ImageAttachment = { mimeType: "image/png", data: "AAAA" };
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(input?: readonly ("text" | "image")[]) {
  const client = installImageClient(input);
  cleanups.push(client.restore);
  const dir = makeTempDir("native-images-");
  cleanups.push(() => cleanupTempDir(dir));
  const store = createMemoryTranscriptStore();
  const adapter = new NativeSessionAdapter([], { ownClient: true });
  const handle = await adapter.openSession("images", {
    agentName: "native",
    workdir: dir,
    transcriptStore: store,
    timeoutSeconds: 60,
    modelDef: { provider: "ignored", model: "stub/stub-model[low]" },
    resolvedPermissions: { mode: "default", bashApproval: "raw" },
  });
  cleanups.push(() => adapter.closeSession(handle));
  const send = (extra: Partial<SendTurnOpts> = {}) =>
    adapter.sendTurn(handle, "look", {
      interactionHandler: { onInteraction: async () => null },
      ...extra,
    });
  return { ...client, adapter, handle, store, send };
}

describe("NativeSessionAdapter image input", () => {
  test.each([
    ["AC-1", ["text", "image"], true],
    ["AC-2", ["text"], false],
    ["AC-3", undefined, false],
  ] as const)("%s: reports the resolved model capability", async (_ac, input, expected) => {
    const { adapter, handle, modelCalls } = await setup(input);
    expect(await adapter.imageInput(handle)).toBe(expected);
    expect(modelCalls).toEqual([["stub", "stub-model"]]);
  });

  test("AC-4: sends the complete image-carrying user seed", async () => {
    const { send, requests } = await setup(["text", "image"]);
    await send({ images: [img] });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.messages.at(-1)).toEqual({ role: "user", content: "look", images: [img] });
  });

  test.each([[undefined], [[]]] as const)("AC-5: omits the images key for %j", async (images) => {
    const { send, requests } = await setup(["text"]);
    await send(images === undefined ? {} : { images });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.messages.at(-1)).toEqual({ role: "user", content: "look" });
    expect(Object.hasOwn(requests[0]?.messages.at(-1) ?? {}, "images")).toBe(false);
  });

  test("AC-6: refuses images with a typed, staged error", async () => {
    const { send } = await setup(["text"]);
    const result = send({ images: [img] });
    await expect(result).rejects.toBeInstanceOf(NaxError);
    await expect(result).rejects.toMatchObject({
      code: "NATIVE_IMAGE_INPUT_UNSUPPORTED",
      context: { stage: "native-session" },
    });
  });

  test.each([
    ["AC-7", ["text"]],
    ["unknown model input", undefined],
  ] as const)("%s: refuses before a model call", async (_ac, input) => {
    const { send, requests } = await setup(input);
    await expect(send({ images: [img] })).rejects.toMatchObject({ code: "NATIVE_IMAGE_INPUT_UNSUPPORTED" });
    expect(requests).toHaveLength(0);
  });

  test("AC-8: refusal leaves no transcript document", async () => {
    const { send, store, handle } = await setup(["text"]);
    await expect(send({ images: [img] })).rejects.toMatchObject({ code: "NATIVE_IMAGE_INPUT_UNSUPPORTED" });
    expect(await store.load(handle.id)).toBeNull();
  });

  test("AC-9: before_turn seed patch replaces images as well as text", async () => {
    const { send, requests } = await setup(["text", "image"]);
    const loopEvents = createLoopEventRegistry();
    loopEvents.register("before_turn", () => ({ seed: [{ role: "user", content: "patched" }] }));
    await send({ images: [img], loopEvents });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.messages.at(-1)).toEqual({ role: "user", content: "patched" });
    expect(Object.hasOwn(requests[0]?.messages.at(-1) ?? {}, "images")).toBe(false);
  });

  test("AC-10: persists images inline in the memory transcript", async () => {
    const { send, store, handle } = await setup(["text", "image"]);
    await send({ images: [img] });
    const doc = await store.load(handle.id);
    expect(doc?.messages.find((message) => message.role === "user")).toEqual({
      role: "user",
      content: "look",
      images: [img],
    });
  });
});
