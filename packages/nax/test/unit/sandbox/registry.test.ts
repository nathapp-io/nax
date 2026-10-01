import { afterEach, describe, expect, test } from "bun:test";
import { makeFakeSandboxBackend, withDepsRestore } from "@test/helpers";
import { DEFAULT_SANDBOX_CONFIG } from "@/config/schemas-sandbox";
import {
  _resetSandboxRegistryForTests,
  _sandboxRegistryDeps,
  probeSandboxOnce,
  resetSandboxBackend,
  sandboxBackendFor,
} from "@/sandbox";

describe("sandbox registry", () => {
  withDepsRestore(_sandboxRegistryDeps);
  afterEach(() => _resetSandboxRegistryForTests());

  test("one backend per process", () => {
    let created = 0;
    _sandboxRegistryDeps.createBackend = () => {
      created += 1;
      return makeFakeSandboxBackend();
    };
    sandboxBackendFor(DEFAULT_SANDBOX_CONFIG);
    sandboxBackendFor(DEFAULT_SANDBOX_CONFIG);
    expect(created).toBe(1);
  });

  test("the probe runs once and its result is cached", async () => {
    let probes = 0;
    _sandboxRegistryDeps.probe = async () => {
      probes += 1;
      return { available: true };
    };
    const b = makeFakeSandboxBackend();
    await probeSandboxOnce(b);
    await probeSandboxOnce(b);
    expect(probes).toBe(1);
  });

  test("reset drops the backend (reset() called) but keeps the probe result", async () => {
    let resets = 0;
    const fake = {
      ...makeFakeSandboxBackend(),
      reset: async () => {
        resets += 1;
      },
    };
    _sandboxRegistryDeps.createBackend = () => fake;
    let probes = 0;
    _sandboxRegistryDeps.probe = async () => {
      probes += 1;
      return { available: true };
    };
    await probeSandboxOnce(sandboxBackendFor(DEFAULT_SANDBOX_CONFIG));
    await resetSandboxBackend();
    expect(resets).toBe(1);
    await probeSandboxOnce(sandboxBackendFor(DEFAULT_SANDBOX_CONFIG));
    expect(probes).toBe(1);
  });

  test("a throwing probe resolves to a cached unavailable result, not a rejection", async () => {
    let probes = 0;
    _sandboxRegistryDeps.probe = () => {
      probes += 1;
      return Promise.reject(new Error("boom"));
    };
    const b = makeFakeSandboxBackend();
    const first = await probeSandboxOnce(b);
    expect(first).toEqual({ available: false, reason: "sandbox probe failed: boom" });
    const second = await probeSandboxOnce(b);
    expect(second).toBe(first);
    expect(probes).toBe(1);
  });
});
