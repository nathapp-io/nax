import { describe, expect, mock, test } from "bun:test";
import type { SessionEvent } from "@nathapp/nax-agent";
import { toolCallEvent } from "@test/helpers";
import { deliverActivity, foregroundRoute, untrackedRoute } from "@/chat/subagent-route";

describe("run routes", () => {
  test("a route for a run no registry can move keeps no event log", () => {
    expect(untrackedRoute().log).toBeUndefined();
  });

  test("a movable foreground route keeps a log", () => {
    expect(foregroundRoute().log).toBeDefined();
  });

  test("an untracked route still forwards tool activity to the turn", () => {
    const forward = mock((_event: SessionEvent) => {});
    deliverActivity(toolCallEvent("c1"), untrackedRoute(), forward);
    expect(forward).toHaveBeenCalledTimes(1);
  });
});
