/**
 * US-011 AC-1..AC-8: ACP brains are named by their agent in the status line and the model
 * picker, and an unavailable agent's row says why. Native labels and details are unchanged.
 */
import { describe, expect, test } from "bun:test";
import { shortModel } from "@/tui/chat/chat-status";
import { pickerModel } from "@/tui/chat/picker-model";

const NOTE = "not installed";

function modelRows(input: {
  models: readonly string[];
  query?: string;
  modelNote?: (model: string) => string | undefined;
  currentModel?: string;
}) {
  return pickerModel({
    kind: "model",
    models: input.models,
    currentModel: input.currentModel ?? "openai/gpt-6",
    currentMode: "guarded",
    ...(input.query === undefined ? {} : { query: input.query }),
    ...(input.modelNote === undefined ? {} : { modelNote: input.modelNote }),
  }).entries;
}

describe("shortModel for ACP brains", () => {
  test("AC-1 names a bare agent by its label", () => {
    expect(shortModel("acp:claude")).toBe("Claude Code");
  });

  test("AC-2 names an agent, its model and the effort suffix", () => {
    expect(shortModel("acp:codex/gpt-5.5[high]")).toBe("Codex · gpt-5.5[high]");
  });

  test("AC-3 keeps a native model's last segment", () => {
    expect(shortModel("openai/gpt-6")).toBe("gpt-6");
  });

  test("AC-4 returns a malformed acp model without throwing", () => {
    expect(() => shortModel("acp:gemini")).not.toThrow();
    expect(shortModel("acp:gemini")).toBe("acp:gemini");
  });
});

describe("pickerModel ACP rows", () => {
  test("AC-5 labels an ACP row by agent and model, leaving a native row's label", () => {
    const rows = modelRows({ models: ["openai/gpt-6", "acp:codex/gpt-5.5"] });
    expect(rows.map((row) => row.label)).toEqual(["openai/gpt-6", "Codex · gpt-5.5"]);
    expect(rows[1]?.value).toBe("acp:codex/gpt-5.5");
  });

  test("AC-6 shows the note of an unavailable row as its detail", () => {
    const rows = modelRows({
      models: ["acp:cursor"],
      modelNote: (model) => (model === "acp:cursor" ? NOTE : undefined),
    });
    expect(rows[0]?.detail).toBe("unavailable: not installed");
  });

  test("AC-7 keeps the effort detail when the note is undefined", () => {
    const rows = modelRows({
      models: ["openai/gpt-6[high]", "acp:codex/gpt-5.5"],
      modelNote: () => undefined,
      currentModel: "openai/gpt-6[high]",
    });
    for (const row of rows) expect(row.detail).toBe(`effort ${row.effortLabel}`);
    expect(rows[0]?.detail).toBe("effort high");
    expect(rows[1]?.detail).toBe("effort default");
  });

  test("AC-8 filtering by agent name matches the ACP row", () => {
    const rows = modelRows({ models: ["openai/gpt-6", "acp:codex/gpt-5.5"], query: "codex" });
    expect(rows.map((row) => row.value)).toEqual(["acp:codex/gpt-5.5"]);
  });

  test("a malformed acp row renders without throwing", () => {
    const rows = modelRows({ models: ["acp:gemini"] });
    expect(rows[0]?.label).toBe("acp:gemini");
  });
});
