import { afterEach, describe, expect, mock, test } from "bun:test";
import { makeLogger } from "@test/helpers";
import { createChatAskController } from "@/chat/ask-controller";
import { createCloseConfirm } from "@/chat/close-confirm";

const controllers: ReturnType<typeof createChatAskController>[] = [];
afterEach(() => {
  for (const asks of controllers.splice(0)) asks.reset();
});

function fixture(jobIds: string[] = [], taskIds: string[] = []) {
  const asks = createChatAskController({ mode: "full", answer: () => {} });
  controllers.push(asks);
  const logger = makeLogger();
  const cancel = mock(async (_id: string) => {});
  const stop = mock((_reason: string) => {
    active = false;
  });
  let active = true;
  const stopLaunching = mock(async () => {});
  const hostJobs = { jobs: { owned: () => jobIds.map((id) => ({ id })), cancel, stopLaunching }, chains: { stop } };
  const stopAll = mock(async () => {});
  const tasks = { running: () => taskIds.map((id) => ({ id })), stopAll };
  const confirm = createCloseConfirm({ hostJobs, tasks, asks, logger });
  const choose = (id: string) => {
    const card = asks.pending()[0];
    if (card?.type !== "host_choice") throw new Error("missing close choice");
    asks.resolveChoice(card.requestId, id);
    return card;
  };
  return { asks, logger, cancel, stop, stopLaunching, stopAll, confirm, choose, active: () => active };
}

describe("createCloseConfirm", () => {
  test("AC-1 AC-2 empty close returns true without an ask and stops chains", async () => {
    const f = fixture();
    expect(await f.confirm()).toBe(true);
    expect(f.asks.pending()).toEqual([]);
    expect(f.stop).toHaveBeenCalledWith("the chat closed");
  });
  test("AC-1 AC-2 optional resources may both be absent", async () => {
    const f = fixture();
    expect(await createCloseConfirm({ asks: f.asks, logger: f.logger })()).toBe(true);
    expect(f.asks.pending()).toEqual([]);
  });
  test("AC-3 AC-4 tasks-only card has stop/stay and the exact summary", async () => {
    const f = fixture([], ["bash-1a2b3c4d"]);
    const result = f.confirm();
    const card = f.choose("stay");
    expect(card.choices.map((c) => c.id)).toEqual(["stop", "stay"]);
    expect(card).toMatchObject({
      tool: "nax-close",
      fallback: "stay",
      summary: "0 nax job(s) and 1 background command(s) still running: bash-1a2b3c4d",
    });
    expect(await result).toBe(false);
  });
  test("AC-5 mixed card has stop/leave/stay and all ids", async () => {
    const f = fixture(["run-12345678"], ["bash-1a2b3c4d"]);
    const result = f.confirm();
    const card = f.choose("stay");
    expect(card.choices.map((c) => c.id)).toEqual(["stop", "leave", "stay"]);
    expect(card.summary).toBe("1 nax job(s) and 1 background command(s) still running: run-12345678, bash-1a2b3c4d");
    expect(await result).toBe(false);
  });
  test.each(["stop", "leave"])("AC-6–13 %s stops chains, awaits task shutdown and returns true", async (choice) => {
    const f = fixture(["run-12345678", "plan-12345678"], ["bash-1a2b3c4d"]);
    const shutdown = Promise.withResolvers<void>();
    const stopping = Promise.withResolvers<void>();
    f.stopAll.mockImplementation(() => {
      stopping.resolve();
      return shutdown.promise;
    });
    let settled = false;
    const result = f.confirm().then((value) => {
      settled = true;
      return value;
    });
    expect(f.active()).toBe(true);
    f.choose(choice);
    await stopping.promise;
    expect(f.stop).toHaveBeenCalledWith("the chat closed");
    expect(f.active()).toBe(false);
    expect(f.cancel.mock.calls.map(([id]) => id)).toEqual(choice === "stop" ? ["run-12345678", "plan-12345678"] : []);
    expect(f.stopAll).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    shutdown.resolve();
    expect(await result).toBe(true);
  });
  test("AC-14–17 stay preserves jobs, tasks and the active chain and returns false", async () => {
    const f = fixture(["run-12345678"], ["bash-1a2b3c4d"]);
    const result = f.confirm();
    f.choose("stay");
    expect(await result).toBe(false);
    expect(f.cancel).not.toHaveBeenCalled();
    expect(f.stopAll).not.toHaveBeenCalled();
    expect(f.stop).not.toHaveBeenCalled();
    expect(f.active()).toBe(true);
  });
  test("AC-6 stop cancels jobs registered while the choice card waits", async () => {
    const ids = ["run-12345678"];
    const f = fixture(ids);
    const result = f.confirm();
    ids.push("plan-87654321");
    f.choose("stop");
    expect(await result).toBe(true);
    expect(f.cancel.mock.calls.map(([id]) => id)).toEqual(ids);
  });
  test("AC-6 stop waits for admitted launches before collecting owned jobs", async () => {
    const ids = ["run-12345678"];
    const f = fixture(ids);
    const settling = Promise.withResolvers<void>();
    const fenced = Promise.withResolvers<void>();
    f.stopLaunching.mockImplementation(async () => {
      fenced.resolve();
      await settling.promise;
      ids.push("plan-87654321");
    });
    const result = f.confirm();
    f.choose("stop");
    await fenced.promise;
    expect(f.active()).toBe(false);
    expect(f.cancel).not.toHaveBeenCalled();
    settling.resolve();
    expect(await result).toBe(true);
    expect(f.cancel.mock.calls.map(([id]) => id)).toEqual(ids);
  });
  test("AC-18 AC-19 cancellation failure warns once and still cancels the next job", async () => {
    const f = fixture(["run-12345678", "plan-12345678"]);
    f.cancel.mockRejectedValueOnce(new Error("cancel failed"));
    const result = f.confirm();
    f.choose("stop");
    expect(await result).toBe(true);
    expect(f.cancel.mock.calls.map(([id]) => id)).toEqual(["run-12345678", "plan-12345678"]);
    expect(f.logger.warn).toHaveBeenCalledTimes(1);
    expect(f.logger.warn).toHaveBeenCalledWith("chat", expect.any(String), {
      jobId: "run-12345678",
      error: "cancel failed",
    });
    expect(f.stopAll).toHaveBeenCalledTimes(1);
  });
});
