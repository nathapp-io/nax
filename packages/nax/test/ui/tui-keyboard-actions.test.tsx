/**
 * App.tsx keyboard-action dispatch and the confirmation dialogs.
 *
 * `useKeyboard` decides which action a keypress means (covered in
 * useKeyboard.test.tsx); this file covers what App.tsx *does* with the action —
 * the queue commands it writes, the overlays and confirmations it opens, and the
 * y/n handling that only exists while a confirmation is up.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir, makeStory as makeUserStory, waitForCondition } from "@test/helpers";
import { render } from "ink-testing-library";
import { act } from "react";
import { PipelineEventEmitter, pipelineEventBus } from "@/pipeline";
import { parseQueueFile } from "@/queue";
import { AgentStreamEventBus } from "@/runtime";
import type { StoryDisplayState } from "@/tui";
import { App } from "@/tui/App";
import { waitForFile } from "../helpers/fs";

const ESC = "\x1b";
const TAB = "\t";
const CTRL_RIGHT_BRACKET = "\x1d";

function makeStory(id: string): StoryDisplayState {
  return {
    story: makeUserStory({ id, title: `Story ${id}`, workdir: "." }),
    status: "pending",
  };
}

/** Puts US-001 into the running state, which is what gates the confirmations. */
function startStory() {
  act(() => {
    pipelineEventBus.emit({
      type: "story:started",
      storyId: "US-001",
      story: { id: "US-001", title: "S", status: "pending", attempts: 0 },
      workdir: ".",
      modelTier: "balanced",
      iteration: 1,
    });
  });
}

async function readQueue(queueFile: string) {
  await waitForFile(queueFile, 1000);
  return parseQueueFile(await Bun.file(queueFile).text()).commands;
}

describe("TUI keyboard actions", () => {
  let tempDir: string;
  let queueFile: string;

  beforeEach(() => {
    pipelineEventBus.clear();
    tempDir = makeTempDir("nax-tui-keys-");
    queueFile = join(tempDir, "queue.txt");
  });

  afterEach(() => {
    pipelineEventBus.clear();
    cleanupTempDir(tempDir);
  });

  const renderApp = (props: { version?: string } = {}) =>
    render(
      <App
        feature="feat"
        stories={[makeStory("US-001")]}
        events={new PipelineEventEmitter()}
        queueFilePath={queueFile}
        {...props}
      />,
    );

  test("p writes a PAUSE command to the queue file", async () => {
    const { stdin, unmount } = renderApp();

    act(() => {
      stdin.write("p");
    });

    expect(await readQueue(queueFile)).toEqual([{ type: "PAUSE" }]);
    unmount();
  });

  test("s writes SKIP for the story that is currently running", async () => {
    const { stdin, unmount } = renderApp();
    startStory();

    act(() => {
      stdin.write("s");
    });

    expect(await readQueue(queueFile)).toEqual([{ type: "SKIP", storyId: "US-001" }]);
    unmount();
  });

  test("a aborts immediately when no story is running", async () => {
    const { stdin, unmount } = renderApp();

    act(() => {
      stdin.write("a");
    });

    expect(await readQueue(queueFile)).toEqual([{ type: "ABORT" }]);
    unmount();
  });

  test("? opens the help overlay and Esc closes it", () => {
    const { stdin, lastFrame, unmount } = renderApp();

    act(() => {
      stdin.write("?");
    });
    expect(lastFrame()).toContain("Abort run");

    act(() => {
      stdin.write(ESC);
    });
    expect(lastFrame()).not.toContain("Abort run");
    unmount();
  });

  test("Tab moves focus to the Agent panel, where the letter shortcuts stop firing", () => {
    const { stdin, lastFrame, unmount } = renderApp();

    act(() => {
      stdin.write(TAB);
    });
    act(() => {
      stdin.write("c");
    });

    expect(lastFrame()).not.toContain("Cost Breakdown");
    unmount();
  });

  test("Ctrl+] returns focus from the Agent panel and the shortcuts fire again", () => {
    const { stdin, lastFrame, unmount } = renderApp();

    act(() => {
      stdin.write(TAB);
    });
    act(() => {
      stdin.write(CTRL_RIGHT_BRACKET);
    });
    act(() => {
      stdin.write("c");
    });

    expect(lastFrame()).toContain("Cost Breakdown");
    unmount();
  });

  test("the version prop is rendered beside the feature name", () => {
    const { lastFrame, unmount } = renderApp({ version: "v0.81.1" });

    expect(lastFrame()).toContain("v0.81.1");
    unmount();
  });
});

describe("TUI abort confirmation (a while a story is running)", () => {
  let tempDir: string;
  let queueFile: string;

  beforeEach(() => {
    pipelineEventBus.clear();
    tempDir = makeTempDir("nax-tui-abort-");
    queueFile = join(tempDir, "queue.txt");
  });

  afterEach(() => {
    pipelineEventBus.clear();
    cleanupTempDir(tempDir);
  });

  const renderRunning = () => {
    const view = render(
      <App
        feature="feat"
        stories={[makeStory("US-001")]}
        events={new PipelineEventEmitter()}
        queueFilePath={queueFile}
      />,
    );
    startStory();
    act(() => {
      view.stdin.write("a");
    });
    return view;
  };

  test("a asks for confirmation instead of aborting", () => {
    const { lastFrame, unmount } = renderRunning();

    expect(lastFrame()).toContain("Abort anyway?");
    unmount();
  });

  test("y confirms and writes the ABORT command", async () => {
    const { stdin, lastFrame, unmount } = renderRunning();

    act(() => {
      stdin.write("y");
    });

    expect(await readQueue(queueFile)).toEqual([{ type: "ABORT" }]);
    expect(lastFrame()).not.toContain("Abort anyway?");
    unmount();
  });

  test("n cancels and writes nothing", async () => {
    const { stdin, lastFrame, unmount } = renderRunning();

    act(() => {
      stdin.write("n");
    });
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    expect(lastFrame()).not.toContain("Abort anyway?");
    expect(await Bun.file(queueFile).exists()).toBe(false);
    unmount();
  });

  test("Esc cancels the same way n does", () => {
    const { stdin, lastFrame, unmount } = renderRunning();

    act(() => {
      stdin.write(ESC);
    });

    expect(lastFrame()).not.toContain("Abort anyway?");
    unmount();
  });

  test("a failed write from the confirmation surfaces inline instead of crashing", async () => {
    // The confirmation's own y-handler is a separate call site from the keyboard
    // path BUG-4 covers, and has its own .catch(); a directory that cannot exist
    // makes the queue-file lock reject before any write is attempted.
    const view = render(
      <App
        feature="feat"
        stories={[makeStory("US-001")]}
        events={new PipelineEventEmitter()}
        queueFilePath="/nax-abort-confirm-nonexistent-dir-xyz/queue.txt"
      />,
    );
    startStory();
    act(() => {
      view.stdin.write("a");
    });
    act(() => {
      view.stdin.write("y");
    });

    await waitForCondition(() => (view.lastFrame() ?? "").includes("couldn't abort"), 1000);

    expect(view.lastFrame()).toContain("couldn't abort");
    view.unmount();
  });

  test("the letter shortcuts are disabled while the confirmation is up", () => {
    const { stdin, lastFrame, unmount } = renderRunning();

    act(() => {
      stdin.write("c");
    });

    expect(lastFrame()).not.toContain("Cost Breakdown");
    expect(lastFrame()).toContain("Abort anyway?");
    unmount();
  });
});

describe("TUI quit confirmation (q while a story is running)", () => {
  beforeEach(() => pipelineEventBus.clear());
  afterEach(() => pipelineEventBus.clear());

  const renderApp = () =>
    render(<App feature="feat" stories={[makeStory("US-001")]} events={new PipelineEventEmitter()} />);

  // ink-testing-library's instance exposes no waitUntilExit, so the exit is
  // observed by its consequence: once useApp().exit() has run the app is
  // unmounted and stops handling input, so "?" no longer opens the help overlay.
  test("q exits straight away when no story is running", () => {
    const { stdin, lastFrame, unmount } = renderApp();

    act(() => {
      stdin.write("q");
    });
    act(() => {
      stdin.write("?");
    });

    expect(lastFrame()).not.toContain("Abort run");
    unmount();
  });

  test("q asks for confirmation while a story is running", () => {
    const { stdin, lastFrame, unmount } = renderApp();
    startStory();

    act(() => {
      stdin.write("q");
    });

    expect(lastFrame()).toContain("Quit anyway?");
    unmount();
  });

  test("y confirms the quit", () => {
    const { stdin, lastFrame, unmount } = renderApp();
    startStory();

    act(() => {
      stdin.write("q");
    });
    act(() => {
      stdin.write("y");
    });
    act(() => {
      stdin.write("?");
    });

    expect(lastFrame()).not.toContain("Quit anyway?");
    expect(lastFrame()).not.toContain("Abort run");
    unmount();
  });

  test("n cancels the quit and leaves the TUI running", () => {
    const { stdin, lastFrame, unmount } = renderApp();
    startStory();

    act(() => {
      stdin.write("q");
    });
    act(() => {
      stdin.write("n");
    });

    expect(lastFrame()).not.toContain("Quit anyway?");
    unmount();
  });
});

describe("TUI header token counters", () => {
  beforeEach(() => pipelineEventBus.clear());
  afterEach(() => pipelineEventBus.clear());

  /** Emits one cumulative usage update and waits for the hook's 150ms drain. */
  async function renderWithTokens(inputTokens: number, outputTokens: number) {
    const agentStreamEvents = new AgentStreamEventBus();
    const view = render(
      <App
        feature="feat"
        stories={[makeStory("US-001")]}
        events={new PipelineEventEmitter()}
        agentStreamEvents={agentStreamEvents}
      />,
    );

    act(() => {
      agentStreamEvents.emitAgentStream({
        kind: "agent.call_started",
        callId: "call-1",
        runId: "run-1",
        agentName: "claude",
        sessionName: "nax-US-001",
        timestamp: 1_000,
        model: "claude-opus-5",
        timeoutSeconds: 600,
      });
      agentStreamEvents.emitAgentStream({
        kind: "agent.usage_update",
        callId: "call-1",
        runId: "run-1",
        agentName: "claude",
        sessionName: "nax-US-001",
        timestamp: 2_000,
        inputTokens,
        outputTokens,
      });
    });

    await waitForCondition(() => (view.lastFrame() ?? "").includes(" in"), 2000);
    return view;
  }

  test("thousands are abbreviated with k", async () => {
    const { lastFrame, unmount } = await renderWithTokens(21_100, 1_500);

    expect(lastFrame()).toContain("21.1k in");
    expect(lastFrame()).toContain("1.5k out");
    unmount();
  });

  test("millions are abbreviated with M", async () => {
    const { lastFrame, unmount } = await renderWithTokens(2_400_000, 900);

    expect(lastFrame()).toContain("2.4M in");
    expect(lastFrame()).toContain("900 out");
    unmount();
  });
});
