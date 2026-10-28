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
    model?: string;
    switchBoth?: boolean;
    resumeChanged?: boolean;
  } = {},
) {
  let state = session("s1", options.title ?? "first session");
  if (options.unsafeSandbox)
    state = { ...state, mode: "full", sandbox: { kind: "unavailable", backend: "srt", reason: "missing" } };
  if (options.model) state = { ...state, model: options.model };
  let history = options.history ?? EMPTY;
  const host: ChatHost = {
    repoRoot: "/repo",
    models: ["p/m", "p/other"],
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
      state = { ...state, ...next, ...(options.switchBoth ? { mode: "full" } : {}) };
    },
    resume: async ({ id = "s2" }) => {
      state = session(id, `title ${id}`);
      if (options.resumeChanged) state = { ...state, model: "p/resumed", mode: "full" };
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

describe("ChatApp switch notices", () => {
  test.each([
    ["AC-1 model", "/model p/other", "p/m", "model: other"],
    ["AC-6 effort", "/effort high", "p/m[low]", "model: m[high]"],
    [
      "unshortened last segment",
      "/model p/nested/a-very-long-model-name-that-must-not-be-shortened[high]",
      "p/m",
      "model: a-very-long-model-name-that-must-not-be-shortened[high]",
    ],
  ])("%s appends once", async (_name, command, model, notice) => {
    const ui = mount({ model });
    await ui.command(command);
    expect(ui.frame().split(notice)).toHaveLength(2);
    await ui.key("\u000f");
    expect(ui.frame().split(notice)).toHaveLength(2);
  });

  test("AC-2 shift+tab appends the actual mode", async () => {
    const ui = mount();
    await ui.key("\u001b[Z");
    expect(ui.host.current().mode).toBe("full");
    expect(ui.frame().split("mode: full")).toHaveLength(2);
  });

  test("AC-3 simultaneous changes append model first", async () => {
    const ui = mount({ switchBoth: true });
    await ui.command("/model p/other");
    inOrder(ui.frame(), "model: other", "mode: full");
  });

  test("AC-4 resume suppresses notices and synchronizes the comparison", async () => {
    const ui = mount({ resumeChanged: true });
    await ui.command("/resume s2");
    expect(ui.host.current()).toMatchObject({ sessionId: "s2", model: "p/resumed", mode: "full" });
    expect(ui.frame()).not.toContain("model:");
    expect(ui.frame()).not.toContain("mode:");
    await ui.command("/model p/other");
    expect(ui.frame().split("model: other")).toHaveLength(2);
    expect(ui.frame()).not.toContain("mode:");
    await ui.command("/mode guarded");
    expect(ui.frame().split("mode: guarded")).toHaveLength(2);
  });

  test("AC-5/9 mount and no-op model append nothing", async () => {
    const ui = mount();
    expect(ui.frame()).not.toContain("model:");
    expect(ui.frame()).not.toContain("mode:");
    await ui.command("/model p/m");
    expect(ui.frame()).not.toContain("model:");
    expect(ui.frame()).not.toContain("mode:");
  });

  test("AC-7/8 model picker stages effort silently and commits one notice", async () => {
    const ui = mount();
    let switches = 0;
    const switchTo = ui.host.switchTo;
    ui.host.switchTo = async (next) => {
      switches += 1;
      await switchTo(next);
    };
    await ui.command("/model");
    await ui.key("\u001b[B");
    await ui.key("\u001b[C");
    await ui.key("\u001b[D");
    expect(switches).toBe(0);
    expect(ui.host.current().model).toBe("p/m");
    expect(ui.frame()).not.toContain("model:");
    await ui.key("\r");
    expect(switches).toBe(1);
    expect(ui.host.current().model).toBe("p/other");
    expect(ui.frame().split("model: other")).toHaveLength(2);
  });

  test("committed effort picker choice appends once", async () => {
    const ui = mount({ model: "p/m[low]" });
    await ui.command("/effort");
    await ui.key("\u001b[B");
    await ui.key("\r");
    expect(ui.host.current().model).not.toBe("p/m[low]");
    const expected = `model: ${ui.host.current().model.slice(2)}`;
    expect(ui.frame().split(expected)).toHaveLength(2);
  });
});

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
    const storedRows = () =>
      ui
        .frame()
        .split("\n")
        .filter((row) => row.includes("stored message"));
    const scrolled = storedRows();
    expect(scrolled.length).toBeGreaterThan(1);
    expect(ui.frame()).not.toContain("resumed first session");
    for (const command of ["/mode full", "/model p/other"]) {
      await ui.command(command);
      expect(ui.host.current().sessionId).toBe("s1");
      expect(storedRows()).toEqual(scrolled);
      expect(ui.frame()).toContain("new lines (End)");
      expect(ui.frame()).not.toContain("resumed first session");
    }
    await ui.key("\u001b[F");
    inOrder(ui.frame(), "mode: full", "model: other");
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
