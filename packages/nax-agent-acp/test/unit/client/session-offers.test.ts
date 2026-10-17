import { describe, expect, test } from "bun:test";
import { sessionOffers } from "#src/client/session-offers";
import { CLAUDE_CONFIG_OPTIONS } from "#test/fixtures/fake-agent/script";

/** What a session/new, session/resume or session/load answer offers a profile. */
describe("sessionOffers (legacy session modes and models)", () => {
  test("reads the modes and models blocks of a response without config options", () => {
    const offers = sessionOffers({
      sessionId: "s",
      modes: {
        availableModes: [
          { id: "default", name: "Default" },
          { id: "plan", name: "Plan" },
        ],
        currentModeId: "default",
      },
      models: {
        availableModels: [
          { modelId: "auto", name: "Auto" },
          { modelId: "m2", name: "M2" },
        ],
        currentModelId: "auto",
      },
    });
    expect(offers).toEqual({ configOptions: [], modeIds: ["default", "plan"], modelIds: ["auto", "m2"] });
  });

  test("returns the response's configOptions array when present", () => {
    const offers = sessionOffers({ sessionId: "s", configOptions: CLAUDE_CONFIG_OPTIONS });
    expect(offers.configOptions).toEqual([...CLAUDE_CONFIG_OPTIONS]);
    expect(offers.modeIds).toEqual([]);
    expect(offers.modelIds).toEqual([]);
  });

  test.each([
    ["a null answer", null],
    ["an empty answer", {}],
    [
      "malformed blocks and malformed ids",
      { modes: "x", models: { availableModels: [{ modelId: 3 }, { modelId: "" }, {}] } },
    ],
  ])("%s: nothing is offered", (_label, response) => {
    expect(sessionOffers(response)).toEqual({ configOptions: [], modeIds: [], modelIds: [] });
  });
});
