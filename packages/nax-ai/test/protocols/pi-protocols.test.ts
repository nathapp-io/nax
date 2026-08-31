import { describe, expect, it } from "vitest";
import { createPiDeps } from "../../src/protocols/pi-client.ts";
import { PI_PROTOCOL_NAMES, piProtocols } from "../../src/protocols/pi-protocols.ts";
import { createRegistry } from "../../src/protocols/registry.ts";

describe("piProtocols", () => {
  it("registers exactly the four pi-backed protocols", () => {
    expect(Object.keys(piProtocols()).sort()).toEqual([...PI_PROTOCOL_NAMES].sort());
  });

  it("registers each protocol under the pi backend only", () => {
    for (const backends of Object.values(piProtocols())) {
      expect(Object.keys(backends)).toEqual(["pi"]);
    }
  });

  it("passes registry validation with the default selection", () => {
    expect(() => createRegistry(piProtocols(), {}).validate()).not.toThrow();
  });

  it("still rejects a native selection, because no native backend exists yet", () => {
    expect(() => createRegistry(piProtocols(), { default: "native" }).validate()).toThrow();
  });

  it("names each resolved protocol after its registry key", async () => {
    const registry = createRegistry(piProtocols(), {});
    for (const name of PI_PROTOCOL_NAMES) {
      expect((await registry.resolve(name)).name).toBe(name);
    }
  });
});

describe("createPiDeps model resolution", () => {
  it("scopes an id served by many providers to the requested provider", async () => {
    const model = await createPiDeps().resolveModel("gpt-5.4", "openai-codex");
    expect(model.provider).toBe("openai-codex");
  });

  it("resolves the same id under a different provider", async () => {
    const model = await createPiDeps().resolveModel("gpt-5.4", "azure-openai-responses");
    expect(model.provider).toBe("azure-openai-responses");
  });

  it("throws naming both the model and the provider for an unknown pairing", async () => {
    await expect(createPiDeps().resolveModel("gpt-5.4", "deepseek")).rejects.toThrow(
      'Unknown model "gpt-5.4" for provider "deepseek" in the pi-ai catalog.',
    );
  });

  it("keeps the global first-match fallback when no provider is given", async () => {
    const model = await createPiDeps().resolveModel("gpt-5.4");
    expect(model.id).toBe("gpt-5.4");
    expect(model.provider).toBeTruthy();
  });
});
