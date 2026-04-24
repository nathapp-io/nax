import { describe, test, expect } from "bun:test";
import { createRuntime } from "../../../src/runtime";
import { DEFAULT_CONFIG } from "../../../src/config";
import { makeTestRuntime } from "../../helpers";

describe("createRuntime", () => {
  test("runtime has required fields", () => {
    const rt = createRuntime(DEFAULT_CONFIG, "/tmp/test");
    expect(rt.configLoader).toBeDefined();
    expect(rt.agentManager).toBeDefined();
    expect(rt.sessionManager).toBeDefined();
    expect(rt.packages).toBeDefined();
    expect(rt.costAggregator).toBeDefined();
    expect(rt.promptAuditor).toBeDefined();
    expect(rt.signal).toBeDefined();
  });

  test("packages.repo() returns root-equivalent view", () => {
    const rt = createRuntime(DEFAULT_CONFIG, "/tmp/test");
    const view = rt.packages.repo();
    expect(view.packageDir).toBe("");
  });

  test("close() resolves without error", async () => {
    const rt = createRuntime(DEFAULT_CONFIG, "/tmp/test");
    await expect(rt.close()).resolves.toBeUndefined();
  });

  test("signal aborted after close()", async () => {
    const rt = createRuntime(DEFAULT_CONFIG, "/tmp/test");
    await rt.close();
    expect(rt.signal.aborted).toBe(true);
  });

  test("close() is idempotent", async () => {
    const rt = createRuntime(DEFAULT_CONFIG, "/tmp/test");
    await rt.close();
    await rt.close();
    expect(rt.signal.aborted).toBe(true);
  });

  test("parentSignal abort propagates to runtime signal", async () => {
    const parent = new AbortController();
    const rt = createRuntime(DEFAULT_CONFIG, "/tmp/test", { parentSignal: parent.signal });
    parent.abort();
    expect(rt.signal.aborted).toBe(true);
  });
});

describe("makeTestRuntime", () => {
  test("produces a valid NaxRuntime with defaults", () => {
    const rt = makeTestRuntime();
    expect(rt.configLoader).toBeDefined();
    expect(rt.agentManager).toBeDefined();
    expect(rt.packages.repo().packageDir).toBe("");
  });

  test("accepts config override", () => {
    const rt = makeTestRuntime({ workdir: "/tmp/custom" });
    expect(rt.workdir).toBe("/tmp/custom");
  });
});
