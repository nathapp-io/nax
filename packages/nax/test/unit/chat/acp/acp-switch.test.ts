import { describe, expect, test } from "bun:test";
import { acpInPlaceChange } from "@/chat/acp";

describe("acpInPlaceChange", () => {
  test("AC-1: an effort added to the same model changes only the effort", () => {
    expect(acpInPlaceChange("acp:codex/gpt-5.5", "acp:codex/gpt-5.5[high]")).toEqual({ effort: "high" });
  });

  test("AC-2: a model change without effort carries only the model", () => {
    expect(acpInPlaceChange("acp:codex/gpt-5.5", "acp:codex/gpt-6-luna")).toEqual({ model: "gpt-6-luna" });
  });

  test("AC-3: a model change carries the target effort when the effort differs too", () => {
    expect(acpInPlaceChange("acp:codex/gpt-5.5[low]", "acp:codex/gpt-6-luna[high]")).toEqual({
      model: "gpt-6-luna",
      effort: "high",
    });
  });

  test("AC-4: a model change carries the target effort even when the effort is unchanged", () => {
    expect(acpInPlaceChange("acp:codex/gpt-5.5[high]", "acp:codex/gpt-6[high]")).toEqual({
      model: "gpt-6",
      effort: "high",
    });
  });

  test("AC-5: dropping the effort (the agent default) reopens", () => {
    expect(acpInPlaceChange("acp:codex/gpt-5.5[high]", "acp:codex/gpt-5.5")).toBeUndefined();
  });

  test("AC-6: dropping the model (the agent default) reopens", () => {
    expect(acpInPlaceChange("acp:codex/gpt-5.5", "acp:codex")).toBeUndefined();
  });

  test("AC-7: a different agent reopens", () => {
    expect(acpInPlaceChange("acp:claude", "acp:codex/gpt-5.5")).toBeUndefined();
  });

  test("AC-8: a native string on either side reopens", () => {
    expect(acpInPlaceChange("openai/gpt-6", "acp:codex/gpt-5.5")).toBeUndefined();
    expect(acpInPlaceChange("acp:codex/gpt-5.5", "openai/gpt-6")).toBeUndefined();
  });

  test("AC-9: identical models change nothing", () => {
    expect(acpInPlaceChange("acp:codex/gpt-5.5", "acp:codex/gpt-5.5")).toBeUndefined();
    expect(acpInPlaceChange("acp:codex/gpt-5.5[high]", "acp:codex/gpt-5.5[high]")).toBeUndefined();
  });

  test("AC-10: a malformed ACP string counts as not ACP instead of throwing", () => {
    expect(acpInPlaceChange("acp:gemini/x", "acp:codex/gpt-5.5")).toBeUndefined();
    expect(acpInPlaceChange("acp:codex/gpt-5.5", "acp:gemini/x")).toBeUndefined();
  });

  test("moving from the agent-default model to a named one carries the model", () => {
    expect(acpInPlaceChange("acp:codex", "acp:codex/gpt-5.5")).toEqual({ model: "gpt-5.5" });
  });
});
