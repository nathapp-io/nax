/**
 * Tests for the TUI "retry last failed story" (r) keybinding end-to-end wiring.
 *
 * Covers the integration point the feature exists for: pressing `r` in the TUI
 * translates the most recently failed story (tracked in bus state) into a
 * `RETRY <id>` queue command that the runner picks up between stories.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { render } from "ink-testing-library";
import { act } from "react";
import { PipelineEventEmitter, pipelineEventBus } from "@/pipeline";
import { parseQueueFile } from "@/queue";
import type { StoryDisplayState } from "@/tui";
import { App } from "@/tui/App";
import { waitForFile } from "../helpers/fs";

function makeStory(id: string): StoryDisplayState {
  return {
    story: { id, title: `Story ${id}`, passes: false, workdir: ".", acceptanceCriteria: [] } as never,
    status: "pending",
  };
}

describe("TUI retry (r) key end-to-end", () => {
  let tempDir: string;
  let queueFile: string;

  beforeEach(() => {
    pipelineEventBus.clear();
    tempDir = makeTempDir("nax-tui-retry-");
    queueFile = join(tempDir, "queue.txt");
  });

  afterEach(() => {
    pipelineEventBus.clear();
    cleanupTempDir(tempDir);
  });

  test("r writes RETRY for the last failed story to the queue file", async () => {
    const emitter = new PipelineEventEmitter();
    const { stdin, unmount } = render(
      <App feature="feat" stories={[makeStory("US-001")]} events={emitter} queueFilePath={queueFile} />,
    );

    act(() => {
      pipelineEventBus.emit({
        type: "story:failed",
        storyId: "US-001",
        story: { id: "US-001", title: "S", status: "failed", attempts: 3 },
        reason: "boom",
        countsTowardEscalation: true,
      });
    });

    act(() => {
      stdin.write("r");
    });

    await waitForFile(queueFile, 1000);
    const { commands } = parseQueueFile(await Bun.file(queueFile).text());
    unmount();

    expect(commands).toEqual([{ type: "RETRY", storyId: "US-001" }]);
  });

  test("r is a no-op when no story has failed", async () => {
    const emitter = new PipelineEventEmitter();
    const { stdin, unmount } = render(
      <App feature="feat" stories={[makeStory("US-001")]} events={emitter} queueFilePath={queueFile} />,
    );

    act(() => {
      stdin.write("r");
    });

    // Give any (unexpected) async write a chance to land before asserting absence.
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    const exists = await Bun.file(queueFile).exists();
    unmount();

    expect(exists).toBe(false);
  });
});
