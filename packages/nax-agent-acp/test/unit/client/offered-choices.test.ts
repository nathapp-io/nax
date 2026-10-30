import { describe, expect, test } from "bun:test";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { MODEL_ID_MAX_CHARS } from "#src/client/capabilities";
import { MAX_OFFERED_CHOICES, offeredChoices } from "#src/client/offered-choices";
import type { SessionOffers } from "#src/client/session-offers";

function select(id: string, category: string | undefined, values: readonly string[]): SessionConfigOption {
  return {
    id,
    name: id,
    ...(category === undefined ? {} : { category }),
    type: "select",
    currentValue: values[0] ?? "",
    options: values.map((value) => ({ value, name: value })),
  };
}

function offers(configOptions: readonly SessionConfigOption[] = [], modelIds: readonly string[] = []): SessionOffers {
  return { configOptions, modeIds: [], modelIds };
}

const modelOption = (values: readonly string[]) => select("model", "model", values);

describe("offeredChoices models", () => {
  test("lists the config model values in offer order, then the legacy model ids", () => {
    const result = offeredChoices(offers([modelOption(["a", "b"])], ["c"]), "codex", []);
    expect(result.models).toEqual(["a", "b", "c"]);
  });

  test("drops a duplicate, keeping the first", () => {
    const result = offeredChoices(offers([modelOption(["a"])], ["a"]), "codex", []);
    expect(result.models).toEqual(["a"]);
  });

  test("drops a model id containing a newline and keeps the others", () => {
    const result = offeredChoices(offers([modelOption(["a", "b\nc", "d"])]), "codex", []);
    expect(result.models).toEqual(["a", "d"]);
  });

  test("drops a model id containing a secret", () => {
    const result = offeredChoices(offers([modelOption(["ok", "x-s3cret-value"])]), "codex", ["s3cret-value"]);
    expect(result.models).toEqual(["ok"]);
  });

  test("drops a model id longer than MODEL_ID_MAX_CHARS", () => {
    const long = "m".repeat(MODEL_ID_MAX_CHARS + 1);
    const exact = "n".repeat(MODEL_ID_MAX_CHARS);
    const result = offeredChoices(offers([modelOption(["a", long, exact])]), "codex", []);
    expect(result.models).toEqual(["a", exact]);
  });

  test("caps the list at MAX_OFFERED_CHOICES, keeping the first in offer order", () => {
    const ids = Array.from({ length: 60 }, (_, i) => `model-${i}`);
    const result = offeredChoices(offers([modelOption(ids)]), "codex", []);
    expect(MAX_OFFERED_CHOICES).toBe(50);
    expect(result.models).toHaveLength(MAX_OFFERED_CHOICES);
    expect(result.models).toEqual(ids.slice(0, 50));
  });

  test("ignores an option that is not category model", () => {
    const result = offeredChoices(offers([select("mode", "mode", ["x"])]), "codex", []);
    expect(result.models).toEqual([]);
  });
});

describe("offeredChoices efforts", () => {
  test("lists the thought_level option's values", () => {
    const result = offeredChoices(offers([select("effort-x", "thought_level", ["low", "high"])]), "claude", []);
    expect(result.efforts).toEqual(["low", "high"]);
  });

  test("uses the agent's fallback option id when there is no thought_level option", () => {
    const result = offeredChoices(offers([select("reasoning_effort", undefined, ["low", "medium"])]), "codex", []);
    expect(result.efforts).toEqual(["low", "medium"]);
  });

  test("offers none for an agent with no fallback id", () => {
    const result = offeredChoices(offers([select("reasoning_effort", undefined, ["low", "medium"])]), "cursor", []);
    expect(result.efforts).toEqual([]);
  });

  test("prefers the thought_level option over the fallback id", () => {
    const options = [select("reasoning_effort", undefined, ["x"]), select("t", "thought_level", ["low"])];
    expect(offeredChoices(offers(options), "codex", []).efforts).toEqual(["low"]);
  });

  test("drops an effort with a control character, a duplicate, and caps the list", () => {
    const values = ["low", "low", "hi\ngh", ...Array.from({ length: 60 }, (_, i) => `e${i}`)];
    const result = offeredChoices(offers([select("t", "thought_level", values)]), "claude", []);
    expect(result.efforts).toHaveLength(MAX_OFFERED_CHOICES);
    expect(result.efforts.slice(0, 3)).toEqual(["low", "e0", "e1"]);
  });
});

describe("offeredChoices with nothing offered", () => {
  test("returns empty lists", () => {
    expect(offeredChoices(offers(), "codex", [])).toEqual({ models: [], efforts: [] });
  });
});
