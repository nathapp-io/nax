import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import { act } from "react";
import { createChatAskController } from "@/chat";
import { AskCard } from "@/tui/chat/AskCard";
import { askCardModel } from "@/tui/chat/ask-card";
import { EMPTY_DRAFT } from "@/tui/chat/ChatInput";
import { resolveChatTheme } from "@/tui/chat/theme";

afterEach(cleanup);

describe("host choice card", () => {
  test.each([
    ["AC-10 number", "2", "stay"],
    ["AC-11 escape", "\x1b", "stay"],
    ["AC-12 Return", "\r", "stop"],
    ["down then Return", "\x1b[B\r", "stay"],
  ])("%s resolves the chosen id", async (_name, key, expected) => {
    const controller = createChatAskController({ mode: "full", answer: () => {} });
    const result = controller.requestHostChoice({
      tool: "nax-close",
      summary: "Quit?",
      reason: "Tasks are running",
      fallback: "stay",
      choices: [
        { id: "stop", label: "Quit and stop them" },
        { id: "stay", label: "Stay in chat" },
      ],
    });
    try {
      const ask = controller.pending()[0];
      if (!ask) throw new Error("missing choice");
      const view = render(
        <AskCard
          ask={ask}
          model={askCardModel(ask, { canRemember: false, entries: [] })}
          controller={controller}
          width={80}
          budget={40}
          theme={resolveChatTheme({ env: {}, colorLevel: 0 })}
          answer={EMPTY_DRAFT}
          onAnswerChange={() => {}}
        />,
      );
      await Promise.resolve(act(async () => {}));
      expect(view.lastFrame()).toContain("1. Quit and stop them");
      expect(view.lastFrame()).toContain("2. Stay in chat");
      if (key === "\x1b[B\r") {
        await Promise.resolve(
          act(async () => {
            view.stdin.write("\x1b[B");
          }),
        );
        await Promise.resolve(
          act(async () => {
            view.stdin.write("\r");
          }),
        );
      } else {
        await Promise.resolve(
          act(async () => {
            view.stdin.write(key);
          }),
        );
      }
      expect(controller.pending()).toEqual([]);
      expect(await result).toBe(expected);
    } finally {
      controller.reset();
    }
  });
});
