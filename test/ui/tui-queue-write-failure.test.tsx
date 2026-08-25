/**
 * BUG-4: `useKeyboard`'s onAction (App.tsx's handleKeyboardAction) is async
 * and awaits a fallible queue-file write. `useInput`'s callback is
 * synchronous and Ink never observes the returned promise, so a rejection
 * (e.g. an unwritable queue file) used to escape as an unhandled rejection —
 * which the crash handler treats as a fatal run crash rather than "couldn't
 * pause".
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { waitForCondition } from "@test/helpers";
import { render } from "ink-testing-library";
import { act } from "react";
import { PipelineEventEmitter, pipelineEventBus } from "@/pipeline";
import type { StoryDisplayState } from "@/tui";
import { App } from "@/tui/App";

function makeStory(id: string): StoryDisplayState {
  return {
    story: { id, title: `Story ${id}`, passes: false, workdir: ".", acceptanceCriteria: [] } as never,
    status: "pending",
  };
}

describe("TUI queue-write failure does not crash the run (BUG-4)", () => {
  let unhandledRejections: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => {
    unhandledRejections.push(reason);
  };

  beforeEach(() => {
    pipelineEventBus.clear();
    unhandledRejections = [];
    process.on("unhandledRejection", onUnhandledRejection);
  });

  afterEach(() => {
    pipelineEventBus.clear();
    process.off("unhandledRejection", onUnhandledRejection);
  });

  test("pressing 'p' with an unwritable queue file surfaces inline instead of an unhandled rejection", async () => {
    // A path under a directory that cannot exist — the queue-file lock's
    // acquire() rejects before any write is attempted.
    const unwritableQueueFile = "/nax-bug4-nonexistent-dir-xyz/queue.txt";
    const { stdin, lastFrame, unmount } = render(
      <App
        feature="feat"
        stories={[makeStory("US-001")]}
        events={new PipelineEventEmitter()}
        queueFilePath={unwritableQueueFile}
      />,
    );

    act(() => {
      stdin.write("p");
    });

    await waitForCondition(() => (lastFrame() ?? "").includes("couldn't pause"), 1000);

    expect(lastFrame()).toContain("couldn't pause");
    unmount();

    expect(unhandledRejections).toEqual([]);
  });
});
