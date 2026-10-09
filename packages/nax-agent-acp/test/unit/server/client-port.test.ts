import { describe, expect, test } from "bun:test";
import { clientFeatures, NO_CLIENT_FEATURES, untilAborted } from "#src/server/client-port";

describe("clientFeatures", () => {
  test("nothing declared means no optional updates and no elicitation", () => {
    expect(clientFeatures(undefined)).toEqual(NO_CLIENT_FEATURES);
    expect(clientFeatures({ session: null, elicitation: null })).toEqual(NO_CLIENT_FEATURES);
  });

  test("reads session.notices, session.compaction and elicitation.form", () => {
    expect(clientFeatures({ session: { notices: {}, compaction: {} }, elicitation: { form: {} } })).toEqual({
      updates: { notices: true, compaction: true },
      elicitation: true,
    });
    expect(clientFeatures({ elicitation: { url: {} } }).elicitation).toBe(false);
  });
});

describe("untilAborted", () => {
  test("settles with the work when not aborted", async () => {
    expect(await untilAborted(Promise.resolve(3), new AbortController().signal)).toBe(3);
  });

  test("passes the work's rejection through", async () => {
    const failed = untilAborted(Promise.reject(new Error("nope")), new AbortController().signal);
    expect(await failed.catch((e: unknown) => (e instanceof Error ? e.message : ""))).toBe("nope");
  });

  test("rejects at once on abort even if the work never settles", async () => {
    const controller = new AbortController();
    const pending = untilAborted(new Promise<number>(() => {}), controller.signal);
    controller.abort(new Error("stop"));
    expect(await pending.catch((e: unknown) => (e instanceof Error ? e.message : ""))).toBe("stop");
  });

  test("rejects at once when already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("early"));
    expect(await untilAborted(Promise.resolve(1), controller.signal).catch(() => "rejected")).toBe("rejected");
  });
});
