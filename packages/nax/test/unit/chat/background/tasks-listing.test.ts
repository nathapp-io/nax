import { describe, expect, test } from "bun:test";
import * as background from "@/chat/background";

describe("formatTasksListing", () => {
  test("AC-11 lists one running command", () => {
    const task: background.BackgroundTask = {
      id: "bash-1a2b3c4d",
      state: "running",
      command: "bun dev",
      startedAt: new Date(0).toISOString(),
      origin: "agent",
      logPath: "/o/log",
    };
    expect(background.formatTasksListing([task])).toBe("bash-1a2b3c4d running bun dev");
    expect(background.formatTasksListing([task, { ...task, state: "failed" }])).toBe(
      "bash-1a2b3c4d running bun dev\nbash-1a2b3c4d failed bun dev",
    );
  });
  test("empty registry has no listing", () => expect(background.formatTasksListing([])).toBe(""));
});
