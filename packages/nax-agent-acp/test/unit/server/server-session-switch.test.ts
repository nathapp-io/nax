import { describe, expect, test } from "bun:test";
import { RequestError } from "@agentclientprotocol/sdk";
import { waitForCondition } from "@nathapp/nax-test-kit/bun/timeout";
import { createServerSession, TURN_TIMEOUT_SECONDS } from "#src/server/server-session";
import type { OldText } from "#src/server/translate/diff";
import { fakeAgentSession, type Script, turnEnd } from "#test/helpers/fake-agent-session";
import { fakePort } from "#test/helpers/fake-client-port";
import { recordingLogger } from "#test/helpers/recording-logger";

const missing = async (): Promise<OldText> => ({ kind: "missing" });
const text = (t: string) => [{ type: "text" as const, text: t }];

const priced: Script = async function* () {
  yield { type: "usage", round: 1, inputTokens: 1, outputTokens: 1, costUsd: 0.5 };
  yield turnEnd("completed");
};

function setup(first: ReturnType<typeof fakeAgentSession>, onTurnEnd?: (m: string) => Promise<void>) {
  const port = fakePort();
  const { logger, lines } = recordingLogger();
  const session = createServerSession({
    session: first.session,
    port: port.port,
    cwd: "/w",
    readOldText: missing,
    logger,
    turnTimeoutSeconds: TURN_TIMEOUT_SECONDS,
    ...(onTurnEnd !== undefined ? { onTurnEnd } : {}),
  });
  return { port, lines, session };
}

describe("switchTo (spec §3.3)", () => {
  test("closes the current S3 session and runs later turns on the new one, with its context window", async () => {
    const a = fakeAgentSession("s1", [priced]);
    const b = fakeAgentSession("s1", [priced]);
    const s = setup(a);
    await s.session.prompt(text("one"));
    await s.session.switchTo(
      async () => ({ session: b.session, contextWindow: 1000 }),
      async () => ({ session: a.session }),
    );
    expect(a.closed()).toBe(true);
    await s.session.prompt(text("two"));
    expect(b.messages).toEqual(["two"]);
    const usage = s.port.updates.filter((u) => u.sessionUpdate === "usage_update");
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ size: 1000, cost: { amount: 1 } });
  });

  test("a failed open restores the old settings' session and rethrows", async () => {
    const a = fakeAgentSession("s1", []);
    const restored = fakeAgentSession("s1", [priced]);
    const s = setup(a);
    const failure = await s.session
      .switchTo(
        async () => Promise.reject(new Error("bad model")),
        async () => ({ session: restored.session }),
      )
      .catch((e: unknown) => e);
    expect(failure instanceof Error ? failure.message : "").toBe("bad model");
    await s.session.prompt(text("after"));
    expect(restored.messages).toEqual(["after"]);
  });

  test("a failed restore is logged and the open error is still returned", async () => {
    const a = fakeAgentSession("s1", []);
    const s = setup(a);
    const failure = await s.session
      .switchTo(
        async () => Promise.reject(new Error("bad model")),
        async () => Promise.reject(new Error("still bad")),
      )
      .catch((e: unknown) => e);
    expect(failure instanceof Error ? failure.message : "").toBe("bad model");
    expect(s.lines.some((l) => l.level === "error" && l.data?.error === "still bad")).toBe(true);
  });

  test("rejected while a turn runs; a prompt during a switch is turn in progress", async () => {
    let releaseOpen: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    const slow: Script = async function* ({ cancelled }) {
      yield { type: "turn_start" };
      await cancelled;
      yield turnEnd("cancelled");
    };
    const a = fakeAgentSession("s1", [slow]);
    const b = fakeAgentSession("s1", []);
    const s = setup(a);
    const running = s.session.prompt(text("long"));
    const busy = await s.session
      .switchTo(
        async () => ({ session: b.session }),
        async () => ({ session: a.session }),
      )
      .catch((e: unknown) => e);
    expect(busy instanceof RequestError ? busy.message : "").toContain("turn in progress");
    s.session.cancel();
    await running;
    const switching = s.session.switchTo(
      async () => {
        await gate;
        return { session: b.session };
      },
      async () => ({ session: a.session }),
    );
    await waitForCondition(() => a.closed());
    const during = await s.session.prompt(text("now")).catch((e: unknown) => e);
    expect(during instanceof RequestError ? during.message : "").toContain("turn in progress");
    releaseOpen();
    await switching;
  });
});

describe("onTurnEnd", () => {
  test("is called with the prompt text after each turn, even an errored one; its failure is only logged", async () => {
    const broken: Script = async function* () {
      yield turnEnd("errored", { error: { code: "X", message: "x" } });
    };
    const seen: string[] = [];
    const a = fakeAgentSession("s1", [priced, broken]);
    const s = setup(a, async (m) => {
      seen.push(m);
      if (seen.length === 2) throw new Error("disk full");
    });
    await s.session.prompt(text("first"));
    await s.session.prompt(text("second")).catch(() => undefined);
    expect(seen).toEqual(["first", "second"]);
    expect(s.lines.some((l) => l.level === "warn" && l.data?.error === "disk full")).toBe(true);
  });

  test("is not called for a prompt rejected before send", async () => {
    const seen: string[] = [];
    const s = setup(fakeAgentSession("s1", []), async (m) => {
      seen.push(m);
    });
    await s.session.prompt([]).catch(() => undefined);
    expect(seen).toEqual([]);
  });
});
