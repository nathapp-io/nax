import { afterEach, describe, expect, mock, test } from "bun:test";
import { assertDefined, cleanupTempDir, makeLogger, makeTempDir, mountChatPicker } from "@test/helpers";
import { cleanup, render } from "ink-testing-library";
import { act } from "react";
import { type ChatHost, type ChatHostState, createChatAskController } from "@/chat";
import { type BackgroundTask, createBackgroundTasks } from "@/chat/background";
import { useJobs } from "@/tui/chat/use-jobs";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  cleanup();
  for (const dispose of disposers.splice(0)) await dispose();
  mock.restore();
});

function tasksFixture() {
  const dir = makeTempDir("footer-tasks-");
  const tasks = createBackgroundTasks({ outputDir: dir, now: () => new Date(), logger: makeLogger() });
  disposers.push(async () => {
    await tasks.stopAll();
    cleanupTempDir(dir);
  });
  return tasks;
}

function adoptRunning(tasks: ReturnType<typeof createBackgroundTasks>, command: string) {
  const end = Promise.withResolvers<{ exitCode: number; timedOut: boolean; aborted: boolean }>();
  tasks.adopt({
    command,
    origin: "agent",
    ended: end.promise,
    stop() {
      end.resolve({ exitCode: 143, timedOut: false, aborted: true });
    },
  });
  return end;
}

const STATE: ChatHostState = {
  sessionId: "footer-tasks",
  mode: "guarded",
  model: "test-model",
  meta: {
    schemaVersion: 1,
    sessionId: "footer-tasks",
    cwd: "/repo",
    mode: "ask",
    model: "test-model",
    bashApproval: "gated",
    title: null,
    createdAt: "now",
    updatedAt: null,
    costUsd: 0,
  },
};

/** A typed host over the given registry; none leaves `host.tasks` absent. */
function hostWith(tasks?: ReturnType<typeof createBackgroundTasks>): ChatHost {
  return {
    repoRoot: "/repo",
    models: [STATE.model],
    asks: createChatAskController({ mode: "guarded", answer: () => {} }),
    ...(tasks === undefined ? {} : { tasks }),
    current: () => STATE,
    notice: () => undefined,
    send: async () => {},
    cancel: () => {},
    start: async () => {},
    close: async () => {},
    clear: async () => {},
    resume: async () => {},
    switchTo: async () => {},
    listSessions: async () => [],
  };
}

function mountHook(host: ChatHost) {
  const seen: Array<readonly BackgroundTask[]> = [];
  function Harness() {
    seen.push(useJobs(host, { idle: false, note: () => {}, deliver: async () => false }).tasks);
    return null;
  }
  render(<Harness />);
  return () => {
    const latest = seen.at(-1);
    assertDefined(latest, "hook result");
    return latest;
  };
}

describe("useJobs tasks", () => {
  test("AC-12 returns the registry's running tasks", () => {
    const tasks = tasksFixture();
    adoptRunning(tasks, "sleep 60");
    const latest = mountHook(hostWith(tasks));
    expect(latest().map((entry) => entry.command)).toEqual(["sleep 60"]);
  });

  test("AC-13 returns an empty array after the registry changes to none", async () => {
    const tasks = tasksFixture();
    const end = adoptRunning(tasks, "sleep 60");
    const latest = mountHook(hostWith(tasks));
    expect(latest()).toHaveLength(1);
    await Promise.resolve(
      act(async () => {
        end.resolve({ exitCode: 0, timedOut: false, aborted: false });
      }),
    );
    // The registry announces the end once its log flush completes.
    await Promise.resolve(act(async () => {}));
    expect(latest()).toEqual([]);
  });

  test("returns no tasks when the host has no registry", () => {
    expect(mountHook(hostWith())()).toEqual([]);
  });
});

describe("ChatApp footer tasks", () => {
  test("AC-14 draws the running task on the footer row", async () => {
    const tasks = tasksFixture();
    const ui = mountChatPicker({ tasks });
    expect(ui.rows().at(-1)).not.toContain("bash sleep 60");
    let end: ReturnType<typeof adoptRunning> | undefined;
    await ui.settleAfter(() => {
      end = adoptRunning(tasks, "sleep 60");
    });
    expect(ui.rows().at(-1)).toContain("bash sleep 60");
    await ui.settleAfter(() => end?.resolve({ exitCode: 0, timedOut: false, aborted: false }));
    await ui.settleAfter(() => {});
    expect(ui.rows().at(-1)).not.toContain("bash sleep 60");
  });
});
