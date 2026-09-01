import { describe, expect, test } from "bun:test";
import { toLoginInteraction } from "@/agents/native/auth";
import type { AuthEvent, AuthInteraction, AuthPrompt } from "@/agents/native/auth-types";

function recorder() {
  const prompts: AuthPrompt[] = [];
  const events: AuthEvent[] = [];
  const interaction: AuthInteraction = {
    prompt: async (prompt) => {
      prompts.push(prompt);
      return "answer";
    },
    notify: (event) => events.push(event),
  };
  return { interaction, prompts, events };
}

describe("toLoginInteraction", () => {
  test("passes a secret prompt through and returns the answer", async () => {
    const { interaction, prompts } = recorder();
    const answer = await toLoginInteraction(interaction).prompt({ type: "secret", message: "Key?" });
    expect(answer).toBe("answer");
    expect(prompts[0]).toEqual({ type: "secret", message: "Key?" });
  });

  test("carries a select prompt's options", async () => {
    const { interaction, prompts } = recorder();
    await toLoginInteraction(interaction).prompt({
      type: "select",
      message: "How?",
      options: [{ id: "api-key", label: "API key" }],
    });
    expect(prompts[0]).toEqual({ type: "select", message: "How?", options: [{ id: "api-key", label: "API key" }] });
  });

  test("carries a manual-code prompt's signal", async () => {
    const { interaction, prompts } = recorder();
    const signal = new AbortController().signal;
    await toLoginInteraction(interaction).prompt({ type: "manual-code", message: "Code?", signal });
    expect(prompts[0]?.type).toBe("manual-code");
    expect(prompts[0]?.signal).toBe(signal);
  });

  test("passes each event kind through unchanged", () => {
    const { interaction, events } = recorder();
    const mapped = toLoginInteraction(interaction);
    mapped.notify({ type: "info", message: "hello" });
    mapped.notify({ type: "auth-url", url: "https://example.test/auth" });
    mapped.notify({ type: "device-code", userCode: "ABCD", verificationUri: "https://example.test/device" });
    mapped.notify({ type: "progress", message: "waiting" });
    expect(events.map((e) => e.type)).toEqual(["info", "auth-url", "device-code", "progress"]);
    expect(events[1]).toEqual({ type: "auth-url", url: "https://example.test/auth" });
  });
});
