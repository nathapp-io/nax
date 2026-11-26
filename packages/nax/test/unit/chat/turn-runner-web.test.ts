import { afterEach, beforeEach, expect, test } from "bun:test";
import { assertDefined, fetchChatPage, makeChatWebHarness, turnEndEvent, WEB_NOW } from "@test/helpers";
import { createHostQueue } from "@/chat/host-queue";
import { createHostCompacting } from "@/chat/host-steer-compact";
import type { ChatSessionHandle } from "@/chat/open-chat-session";
import { runChatTurn } from "@/chat/turn-runner";

let h: ReturnType<typeof makeChatWebHarness>;
beforeEach(() => {
  h = makeChatWebHarness();
});
afterEach(async () => {
  await h.dispose();
});
function run(handle: ChatSessionHandle) {
  return runChatTurn({
    handle,
    storage: h.storage,
    message: "hello",
    now: WEB_NOW.toISOString(),
    asks: { handle() {} },
    ledger: { record() {}, drain: async () => {} },
    onEvent() {},
  });
}

test("AC-7 turn-end metadata uses live exposure instead of stale opener metadata", async () => {
  const handle = await h.open();
  // Construct the live handle independently so this regression targets turn-runner itself.
  const { web } = await h.deps.createChatWeb({
    config: h.config,
    repoRoot: h.dir,
    meta: handle.meta,
    backend: "native",
  });
  assertDefined(web);
  await fetchChatPage(web);
  const result = await run({ ...handle, web });
  expect(result.web).toEqual(expect.objectContaining(web.exposure.snapshot()));
  expect((await h.storage.readMeta(handle.meta.sessionId))?.web).toEqual(result.web);
});
test("AC-8 abort immediately after fetch cannot overwrite exposed storage with handle.meta", async () => {
  const handle = await h.open();
  h.script(async function* () {
    await fetchChatPage(handle.web);
    h.session.cancel();
    const end = turnEndEvent();
    yield {
      ...end,
      type: "turn_end",
      status: "cancelled",
      output: "",
      usage: { inputTokens: 0, outputTokens: 0 },
      costUsd: 0,
    };
  });
  await run(handle);
  await handle.release();
  expect((await h.storage.readMeta(handle.meta.sessionId))?.web?.exposedAt).toBeString();
});
test("AC-21 a handle without web retains the stored snapshot, not stale handle.meta.web", async () => {
  const handle = await h.open();
  const web = { exposedAt: WEB_NOW.toISOString(), seenUrls: ["https://b.example/doc"], searches: 3 };
  await h.storage.writeMeta({ ...handle.meta, web });
  const { web: _web, ...withoutWeb } = handle;
  expect((await run(withoutWeb)).web).toEqual(web);
});
test("exposure changes serialize with turn and compaction metadata read-modify-writes", async () => {
  const handle = await h.open();
  const entered = Promise.withResolvers<void>();
  const unblock = Promise.withResolvers<void>();
  const readMeta = h.storage.readMeta;
  let blocked = false;
  h.storage.readMeta = async (id) => {
    const meta = await readMeta(id);
    if (!blocked) {
      blocked = true;
      entered.resolve();
      await unblock.promise;
    }
    return meta;
  };
  const turning = run(handle);
  await entered.promise;
  await fetchChatPage(handle.web);
  h.session.compact = async () => ({
    compacted: true,
    tokensBefore: 10,
    tokensAfter: 1,
    usage: { inputTokens: 1, outputTokens: 1 },
    costUsd: 2,
  });
  const compacting = createHostCompacting({
    session: () => handle.session,
    handle: () => handle,
    storage: h.storage,
    ledger: () => undefined,
    now: () => WEB_NOW,
    queue: createHostQueue(),
    adopt() {},
  }).compact();
  unblock.resolve();
  await Promise.all([turning, compacting]);
  await handle.release();
  const stored = await readMeta(handle.meta.sessionId);
  expect(handle.web?.exposure.snapshot()).toEqual(stored?.web);
  expect(stored?.web?.exposedAt).toBeString();
  expect(stored?.costUsd).toBe(2);
});
