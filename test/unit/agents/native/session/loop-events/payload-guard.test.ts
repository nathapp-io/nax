import { describe, expect, test } from "bun:test";
import { createLoopEventRegistry } from "@/agents/native/session/loop-events";
import type { BeforeTurnEndPayload } from "@/agents/native/session/loop-events/types";
import { addSink, initLogger, resetLogger } from "@/logger";
import type { LogEntry } from "@/logger/types";

async function captureWarnings(run: () => Promise<unknown>): Promise<LogEntry[]> {
  const logCalls: LogEntry[] = [];
  resetLogger();
  initLogger({ level: "info", suppressConsole: true });
  addSink((entry) => logCalls.push(entry));
  try {
    await run();
  } finally {
    resetLogger();
  }
  return logCalls.filter((e) => e.level === "warn");
}

function turnEnd(messages: BeforeTurnEndPayload["messages"]): BeforeTurnEndPayload {
  return { messages, roundTrips: 1, stopped: false, followUpsSoFar: 0, ended: "completed" };
}

const pushInto = (arr: readonly unknown[], item: unknown): void => {
  Reflect.apply(Array.prototype.push, arr, [item]);
};

describe("review #19: in-place payload mutation", () => {
  test("a push is detected, warned and undone on the same array", async () => {
    const registry = createLoopEventRegistry();
    registry.register("before_turn_end", (p) => {
      pushInto(p.messages, { role: "user", content: "sneaky" });
      return {};
    });
    const messages: BeforeTurnEndPayload["messages"] = [{ role: "user", content: "hi" }];
    const warnings = await captureWarnings(() => registry.dispatch("before_turn_end", turnEnd(messages)));
    expect(messages).toHaveLength(1);
    expect(warnings.some((w) => w.message.includes("mutated payload in place"))).toBe(true);
  });

  test("a splice is undone and the original element references come back", async () => {
    const registry = createLoopEventRegistry();
    registry.register("before_turn_end", (p) => {
      Reflect.apply(Array.prototype.splice, p.messages, [0, 1]);
      return {};
    });
    const first = { role: "user" as const, content: "hi" };
    const messages: BeforeTurnEndPayload["messages"] = [first];
    await captureWarnings(() => registry.dispatch("before_turn_end", turnEnd(messages)));
    expect(messages[0]).toBe(first);
  });

  test("a handler that mutates and returns nothing never changes the dispatch result", async () => {
    const registry = createLoopEventRegistry();
    registry.register("before_turn_end", () => ({ followUp: "next" }));
    const messages: BeforeTurnEndPayload["messages"] = [{ role: "user", content: "hi" }];
    const patch = await registry.dispatch("before_turn_end", turnEnd(messages));
    expect(patch.followUp).toBe("next");
  });

  test("before_tool: a tools.push is undone", async () => {
    const registry = createLoopEventRegistry();
    registry.register("before_tool", (p) => {
      pushInto(p.tools, { name: "Evil", description: "", inputSchema: {} });
      return { kind: "allow" };
    });
    const tools = [{ name: "Read", description: "read", inputSchema: {} }];
    await captureWarnings(() =>
      registry.dispatch("before_tool", { call: { id: "c1", name: "Read", input: {} }, tools }),
    );
    expect(tools).toHaveLength(1);
  });
});
