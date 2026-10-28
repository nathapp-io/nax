import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import { act } from "react";
import { type ChatHistory, type ChatHost, type ChatHostState, createChatAskController } from "@/chat";
import { ChatApp } from "@/tui/chat";

const INTERRUPTED = "The last turn was interrupted. Send a message to continue it.";
const SKILL_TITLE = '<skill name="superpowers:brainstorming" source="test">body</skill>';
const EMPTY: ChatHistory = { messages: [] };
const HISTORY: ChatHistory = {
  messages: [
    { role: "user", content: "earlier question" },
    { role: "assistant", content: "earlier answer" },
  ],
};

afterEach(cleanup);

function session(id: string, title: string | null): ChatHostState {
  return {
    sessionId: id,
    mode: "guarded",
    model: "p/m",
    meta: {
      schemaVersion: 1,
      sessionId: id,
      cwd: "/repo",
      mode: "ask",
      model: "p/m",
      bashApproval: "gated",
      title,
      createdAt: "now",
      updatedAt: null,
      costUsd: 0,
    },
  };
}

function mount(
  options: {
    history?: ChatHistory;
    resumeHistory?: ChatHistory;
    title?: string;
    missingHistory?: boolean;
    resource?: string;
    interrupted?: boolean;
    unsafeSandbox?: boolean;
  } = {},
) {
  let state = session("s1", options.title ?? "first session");
  if (options.unsafeSandbox)
    state = { ...state, mode: "full", sandbox: { kind: "unavailable", backend: "srt", reason: "missing" } };
  let history = options.history ?? EMPTY;
  const host: ChatHost = {
    repoRoot: "/repo",
    models: ["p/m"],
    asks: createChatAskController({ mode: "guarded", answer: () => {} }),
    current: () => state,
    history: () => history,
    notice: () => (options.interrupted ? INTERRUPTED : undefined),
    resourceNotice: () => options.resource,
    start: async () => {},
    close: async () => {},
    cancel: () => {},
    send: async () => {},
    clear: async () => {
      state = session("new", null);
      history = EMPTY;
    },
    switchTo: async (next) => {
      state = { ...state, ...next };
    },
    resume: async ({ id = "s2" }) => {
      state = session(id, `title ${id}`);
      history = options.resumeHistory ?? { messages: [{ role: "user", content: `from ${id}` }] };
    },
    listSessions: async () => [session("s2", "title s2").meta],
  };
  if (options.missingHistory) delete host.history;
  const ui = render(<ChatApp host={host} />);
  const key = async (text: string) => {
    await Promise.resolve(
      act(async () => {
        ui.stdin.write(text);
      }),
    );
  };
  const command = async (text: string) => {
    await key(text);
    await key("\r");
  };
  return { ...ui, host, key, command, frame: () => ui.lastFrame() ?? "" };
}

function inOrder(frame: string, ...texts: string[]): void {
  let previous = -1;
  for (const text of texts) {
    const index = frame.indexOf(text, previous + 1);
    expect(index).toBeGreaterThan(previous);
    previous = index;
  }
}

// The welcome card's stable label, separate from the product header.
const WELCOME = "skills 0 · commands 0";

describe("ChatApp session transcript", () => {
  test.each([
    ["AC-1 empty history", {}],
    ["AC-7 optional history", { missingHistory: true }],
    ["non-renderable stored messages", { history: { messages: [{ role: "user", content: "" }] } }],
  ] satisfies [string, Parameters<typeof mount>[0]][])("%s draws welcome only", (_name, options) => {
    const ui = mount(options);
    expect(ui.frame()).toContain(WELCOME);
    expect(ui.frame()).not.toContain("resumed ");
  });

  test.each(["direct", "picker"])("resumed skill starts collapsed via %s resume", async (path) => {
    const content =
      '<skill name="superpowers:brainstorming" location="/p">\nrefs\nprivate skill body\n</skill>\n\nplan it';
    const ui = mount({ resumeHistory: { messages: [{ role: "user", content }] } });
    await ui.command(path === "direct" ? "/resume s2" : "/resume");
    if (path === "picker") await ui.key("\r");
    expect(ui.host.current().sessionId).toBe("s2");
    expect(ui.frame()).toContain("> /superpowers:brainstorming plan it");
    expect(ui.frame()).toContain("⎿  skill superpowers:brainstorming · 1 line (ctrl+o to show)");
    expect(ui.frame()).not.toContain("private skill body");
    await ui.key("\u000f");
    expect(ui.frame()).toContain("private skill body");
  });

  test("AC-2 replays opening history after welcome", () => {
    const ui = mount({ history: HISTORY });
    inOrder(ui.frame(), WELCOME, "earlier question", "earlier answer", "resumed first session");
  });

  test.each(["direct", "picker"])("AC-3/4 %s resume replaces old rows", async (path) => {
    const ui = mount({ history: HISTORY });
    await ui.command("live before resume");
    expect(ui.frame()).toContain("live before resume");
    await ui.command(path === "direct" ? "/resume s2" : "/resume");
    if (path === "picker") {
      expect(ui.frame()).toContain("Resume a session");
      expect(ui.frame()).toContain("title s2");
      await ui.key("\r");
    }
    expect(ui.host.current().sessionId).toBe("s2");
    expect(ui.frame().split("\n")[0]).toEndWith(" · title s2");
    inOrder(ui.frame(), WELCOME, "from s2", "resumed title s2");
    expect(ui.frame()).not.toContain("earlier question");
    expect(ui.frame()).not.toContain("earlier answer");
    expect(ui.frame()).not.toContain("live before resume");
  });

  test.each(["direct", "picker"])("B1 %s resume follows the new session after PageUp", async (path) => {
    const history = (count: number, label: string): ChatHistory => ({
      messages: Array.from({ length: count }, (_, index) => ({ role: "user", content: `${label} message ${index}` })),
    });
    const ui = mount({ history: history(30, "old"), resumeHistory: history(40, "new") });
    expect(ui.frame()).toContain("resumed first session");
    await ui.key("\u001b[5~");
    expect(ui.frame()).not.toContain("resumed first session");
    await ui.command(path === "direct" ? "/resume s2" : "/resume");
    if (path === "picker") await ui.key("\r");
    expect(ui.host.current().sessionId).toBe("s2");
    inOrder(ui.frame(), "new message 39", "resumed title s2");
    expect(ui.frame()).not.toContain("new lines (End)");
    expect(ui.frame()).not.toContain("old message");
  });

  test("B1 same-id mode and model switches preserve the scrolled viewport", async () => {
    const ui = mount({
      history: {
        messages: Array.from({ length: 30 }, (_, index) => ({ role: "user", content: `stored message ${index}` })),
      },
    });
    await ui.key("\u001b[5~");
    const transcript = () => ui.frame().split("\n").slice(2, -2).join("\n");
    const scrolled = transcript();
    expect(ui.frame()).not.toContain("resumed first session");
    for (const command of ["/mode full", "/model p/m"]) {
      await ui.command(command);
      expect(ui.host.current().sessionId).toBe("s1");
      expect(transcript()).toBe(scrolled);
    }
  });

  test("AC-5 same-id mode and model changes preserve replay and live entries", async () => {
    const ui = mount({ history: HISTORY });
    await ui.command("live row");
    await ui.command("/mode full");
    await ui.command("/model p/m");
    inOrder(ui.frame(), WELCOME, "earlier question", "earlier answer", "resumed first session", "live row");
    expect(ui.host.current().sessionId).toBe("s1");
    expect(ui.host.current().mode).toBe("full");
  });

  test("AC-6 clear transitions to welcome only", async () => {
    const ui = mount({ history: HISTORY });
    await ui.command("live row");
    await ui.command("/clear");
    expect(ui.host.current().sessionId).toBe("new");
    expect(ui.frame()).toContain(WELCOME);
    for (const text of ["earlier question", "earlier answer", "live row", "resumed "])
      expect(ui.frame()).not.toContain(text);
  });

  test("AC-8 skill-envelope title is readable in resumed notice and header", () => {
    const ui = mount({ history: HISTORY, title: SKILL_TITLE });
    expect(ui.frame()).toContain("resumed /superpowers:brainstorming");
    expect(ui.frame().split("\n")[0]).toContain(" · /superpowers:brainstorming");
    expect(ui.frame()).not.toContain("<skill");
  });

  test("AC-9 resource mount notice follows replay", async () => {
    const ui = mount({ history: HISTORY, resource: "resource notice" });
    await Promise.resolve(act(async () => {}));
    inOrder(ui.frame(), WELCOME, "earlier question", "earlier answer", "resumed first session", "resource notice");
  });

  test("AC-10 identical interruption notice follows each session rebuild", async () => {
    const ui = mount({ interrupted: true });
    for (const id of ["s2", "s3"]) {
      await ui.command(`/resume ${id}`);
      inOrder(ui.frame(), WELCOME, `from ${id}`, `resumed title ${id}`, INTERRUPTED);
      expect(ui.frame().split(INTERRUPTED)).toHaveLength(2);
    }
    expect(ui.frame()).not.toContain("from s2");
  });

  test("sandbox mount warning follows opening replay without erasing other mount notices", async () => {
    const ui = mount({ history: HISTORY, interrupted: true, resource: "resource notice", unsafeSandbox: true });
    await Promise.resolve(act(async () => {}));
    inOrder(
      ui.frame(),
      "earlier answer",
      "resumed first session",
      "resource notice",
      INTERRUPTED,
      "sandbox unavailable: commands run outside the sandbox",
    );
  });

  test("AC-11 opening interruption notice follows resumed notice", async () => {
    const ui = mount({ history: HISTORY, interrupted: true });
    await Promise.resolve(act(async () => {}));
    inOrder(ui.frame(), "earlier answer", "resumed first session", INTERRUPTED);
  });
});
