import type { SessionEventBody, SteerResult } from "@nathapp/nax-agent";
import { mountChatPicker } from "@test/helpers";
import { act } from "react";

export function frameHarness(options: Parameters<typeof mountChatPicker>[0] = {}) {
  const screen = mountChatPicker(options);
  const resize = async (height: number | undefined, width: number | undefined = 80) => {
    Object.defineProperty(screen.ui.stdout, "columns", { value: width, configurable: true });
    Object.defineProperty(screen.ui.stdout, "rows", { value: height, configurable: true });
    await screen.settleAfter(() => screen.ui.stdout.emit("resize"));
  };
  const type = (text: string) => screen.press(text);
  const ask = (body: SessionEventBody) =>
    act(() => {
      screen.host.asks.handle({ sessionId: "picker-session", turnId: "t1", at: "now", metadata: {}, ...body });
    });
  const steers: ReturnType<typeof Promise.withResolvers<boolean>>[] = [];
  screen.host.steer = (text: string): SteerResult => {
    const applied = Promise.withResolvers<boolean>();
    steers.push(applied);
    return { status: "accepted", steerId: `${steers.length}-${text}`, applied: applied.promise };
  };
  const steer = (text: string) => {
    type(text);
    screen.press("\x13");
  };
  const start = async () => {
    await screen.submit("hello");
    screen.emit({ type: "turn_start" });
  };
  return { ...screen, resize, type, ask, steers, steer, start };
}

export const QUESTION = { type: "question", requestId: "q1", text: "Proceed?", expiresAt: "later" } as const;
export const APPROVAL = {
  type: "approval_requested",
  requestId: "a1",
  tool: "Bash",
  command: "echo hi",
  reason: "Run this command",
  expiresAt: "later",
} as const;
export const COMPLETED = {
  type: "turn_end",
  status: "completed",
  output: "",
  costUsd: 0,
  usage: { inputTokens: 0, outputTokens: 0 },
} as const;
