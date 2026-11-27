/**
 * US-005: only text a person typed is recorded as seen URLs.
 *
 * The recording rule used to live in the session wrapper, which records every message the model
 * or the host composes as well as the ones a person types. So a model-authored background
 * command could mark any URL as seen, and a later `web__fetch` of that URL would skip the
 * unseen-URL ask. Recording now happens at the two places a person's text enters the host — a
 * typed `send` and an accepted `steer` — and a host-generated turn (`automatic`) records nothing.
 *
 * The fixture is the web-enabled native handle `open-chat-session-web.test.ts` builds, opened
 * through `createChatHost` so both the host's own rule and the wrapper it composes are real.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import type { SendInput, SteerResult } from "@nathapp/nax-agent";
import { assertDefined, makeChatWebHarness, makeLogger, makeNaxConfig, turnEndEvent, WEB_NOW } from "@test/helpers";
import { createChatHost } from "@/chat";
import { formatMentionMessage } from "@/chat/mentions/mention-envelope";
import type { ChatWeb } from "@/chat/web/wiring";

let h: ReturnType<typeof makeChatWebHarness> | undefined;
const hosts: ReturnType<typeof createChatHost>[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  await h?.dispose();
  h = undefined;
});

interface Fixture {
  readonly harness: ReturnType<typeof makeChatWebHarness>;
  readonly host: ReturnType<typeof createChatHost>;
  readonly web: ChatWeb;
}

/**
 * A `NativeChatHost` over the web-enabled native handle. The harness's own `open` is what the
 * host calls, so the handle carries the exposure the assertions read.
 */
async function fixture(): Promise<Fixture> {
  const harness = makeChatWebHarness();
  h = harness;
  const host = createChatHost({
    config: makeNaxConfig({ chat: harness.config.chat, outputDir: join(harness.dir, "output") }),
    cwd: harness.dir,
    repoRoot: harness.dir,
    chain: null,
    storage: harness.storage,
    now: () => WEB_NOW,
    logger: makeLogger(),
    open: async (request) => harness.open(request),
  });
  hosts.push(host);
  await host.start({ mode: "full", model: "anthropic/test" });
  const web = harness.web();
  assertDefined(web, "session web");
  return { harness, host, web };
}

/**
 * A session `send` that runs one empty turn and records what it was given. A case that asserts
 * an absence uses it so the assertion cannot pass by the turn never happening at all.
 */
function spySend(harness: Fixture["harness"]) {
  const send = mock((_message: string) =>
    (async function* () {
      yield turnEndEvent();
    })(),
  );
  harness.session.send = send;
  return send;
}

describe("a typed send records its URLs", () => {
  test("AC-1 the URL is seen by the time the session's send is first called", async () => {
    const { harness, host, web } = await fixture();
    const seenAtSend: boolean[] = [];
    const send = mock((message: string) => {
      seenAtSend.push(web.exposure.hasSeen("https://b.example/doc"));
      return (async function* () {
        yield turnEndEvent(message);
      })();
    });
    harness.session.send = send;
    await host.send("read https://b.example/doc", () => {});
    expect(seenAtSend).toEqual([true]);
    expect(web.exposure.hasSeen("https://b.example/doc")).toBe(true);
  });

  test("AC-4 the session's own send records nothing, and still forwards what it was given", async () => {
    const { harness, web } = await fixture();
    const handle = harness.handles[0];
    assertDefined(handle, "opened handle");
    const send = mock((message: string, _input?: SendInput) => {
      expect(web.exposure.hasSeen("https://d.example/y")).toBe(false);
      return (async function* () {
        yield turnEndEvent(message);
      })();
    });
    harness.session.send = send;
    const input: SendInput = { images: [{ data: "AA==", mimeType: "image/png" }] };
    for await (const _ of handle.session.send("read https://d.example/y", input)) {
      /* consume */
    }
    expect(send).toHaveBeenCalledWith("read https://d.example/y", input);
    expect(web.exposure.hasSeen("https://d.example/y")).toBe(false);
  });
});

describe("a generated turn records nothing", () => {
  test("AC-2 a background-command notice's URL stays unseen", async () => {
    const { harness, host, web } = await fixture();
    const send = spySend(harness);
    const notice = "[nax-tasks] background command bash-1 (curl https://evil.example/x) ended";
    await host.send(notice, () => {}, { automatic: true });
    // The turn ran with the notice's own text; only the recording is withheld.
    expect(send).toHaveBeenCalledWith(notice);
    expect(web.exposure.hasSeen("https://evil.example/x")).toBe(false);
  });

  test("AC-3 a URL inside an attached file's body stays unseen", async () => {
    const { harness, host, web } = await fixture();
    const send = spySend(harness);
    const message = formatMentionMessage("see file", [
      { path: "a.txt", status: "attached", note: "", body: "https://c.example/x" },
    ]);
    await host.send(message, () => {});
    expect(send).toHaveBeenCalledWith(message);
    expect(web.exposure.snapshot().seenUrls).toEqual([]);
  });
});

describe("only an accepted typed steer records its URLs", () => {
  test("AC-5 an accepted typed steer records its URL", async () => {
    const { harness, host, web } = await fixture();
    const steer = mock(
      (_text: string): SteerResult => ({ status: "accepted", steerId: "steer-1", applied: Promise.resolve(true) }),
    );
    harness.session.steer = steer;
    expect(host.steer?.("see https://e.example/z")).toMatchObject({ status: "accepted" });
    expect(steer).toHaveBeenCalledWith("see https://e.example/z");
    expect(web.exposure.hasSeen("https://e.example/z")).toBe(true);
  });

  test("AC-6 an accepted automatic steer records nothing", async () => {
    const { harness, host, web } = await fixture();
    const steer = mock(
      (_text: string): SteerResult => ({ status: "accepted", steerId: "steer-1", applied: Promise.resolve(true) }),
    );
    harness.session.steer = steer;
    host.steer?.("see https://f.example/z", { automatic: true });
    expect(steer).toHaveBeenCalledWith("see https://f.example/z");
    expect(web.exposure.hasSeen("https://f.example/z")).toBe(false);
  });

  test("AC-10 a steer the session does not support records nothing", async () => {
    const { harness, host, web } = await fixture();
    const steer = mock((_text: string): SteerResult => ({ status: "unsupported" }));
    harness.session.steer = steer;
    expect(host.steer?.("see https://g.example/z")).toEqual({ status: "unsupported" });
    expect(steer).toHaveBeenCalledWith("see https://g.example/z");
    expect(web.exposure.hasSeen("https://g.example/z")).toBe(false);
  });
});
