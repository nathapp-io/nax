// test/protocols/registry.test.ts
import { describe, expect, it, vi } from "vitest";
import { createRegistry, UnknownProtocolError, UnregisteredBackendError } from "../../src/protocols/registry.ts";
import type { Protocol } from "../../src/protocols/types.ts";

const stubProtocol = (name: string): Protocol => ({
  name,
  // biome-ignore lint/correctness/useYield: stub generator; a real stream is the factory's job.
  async *stream() {
    return;
  },
});

describe("createRegistry", () => {
  it("does not invoke a backend factory until resolve is called", () => {
    const factory = vi.fn(async () => stubProtocol("p"));
    createRegistry({ p: { pi: factory } });
    expect(factory).not.toHaveBeenCalled();
  });

  it("resolves the pi backend by default", async () => {
    const registry = createRegistry({ p: { pi: async () => stubProtocol("p") } });
    await expect(registry.resolve("p")).resolves.toMatchObject({ name: "p" });
  });

  it("caches the resolved protocol so the factory runs once", async () => {
    const factory = vi.fn(async () => stubProtocol("p"));
    const registry = createRegistry({ p: { pi: factory } });
    await registry.resolve("p");
    await registry.resolve("p");
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("honours a per-protocol override", async () => {
    const registry = createRegistry(
      {
        p: {
          pi: async () => stubProtocol("pi-impl"),
          native: async () => stubProtocol("native-impl"),
        },
      },
      { byProtocol: { p: "native" } },
    );
    await expect(registry.resolve("p")).resolves.toMatchObject({ name: "native-impl" });
  });

  it("throws rather than falling back when the selected backend is unregistered", async () => {
    // A silent fallback to pi would make an A/B comparison report results for
    // an implementation that never ran. This must fail loudly.
    const registry = createRegistry({ p: { pi: async () => stubProtocol("p") } }, { byProtocol: { p: "native" } });
    await expect(registry.resolve("p")).rejects.toThrow(UnregisteredBackendError);
  });

  it("throws for an unknown protocol name", async () => {
    const registry = createRegistry({ p: { pi: async () => stubProtocol("p") } });
    await expect(registry.resolve("nope")).rejects.toThrow(UnknownProtocolError);
  });

  it("reports available backends per protocol", () => {
    const registry = createRegistry({
      p: { pi: async () => stubProtocol("p"), native: async () => stubProtocol("p") },
      q: { pi: async () => stubProtocol("q") },
    });
    expect(registry.available().get("p")).toEqual(["pi", "native"]);
    expect(registry.available().get("q")).toEqual(["pi"]);
  });

  it("validate() surfaces a selection naming an unregistered backend", () => {
    const registry = createRegistry({ p: { pi: async () => stubProtocol("p") } }, { byProtocol: { p: "native" } });
    expect(() => registry.validate()).toThrow(UnregisteredBackendError);
  });

  it("validate() surfaces a selection naming an unknown protocol", () => {
    const registry = createRegistry({ p: { pi: async () => stubProtocol("p") } }, { byProtocol: { typo: "pi" } });
    expect(() => registry.validate()).toThrow(UnknownProtocolError);
  });

  it("validate() passes for a satisfiable selection", () => {
    const registry = createRegistry(
      { p: { pi: async () => stubProtocol("p"), native: async () => stubProtocol("p") } },
      { byProtocol: { p: "native" } },
    );
    expect(() => registry.validate()).not.toThrow();
  });

  it("validate() surfaces a default selection naming an unregistered backend", () => {
    // A { default: "native" } selection against a pi-only registry must fail
    // at startup, not on the first resolve().
    const registry = createRegistry({ p: { pi: async () => stubProtocol("p") } }, { default: "native" });
    expect(() => registry.validate()).toThrow(UnregisteredBackendError);
  });

  it("validate() passes for a satisfiable default selection", () => {
    const registry = createRegistry(
      { p: { pi: async () => stubProtocol("p"), native: async () => stubProtocol("p") } },
      { default: "native" },
    );
    expect(() => registry.validate()).not.toThrow();
  });
});
