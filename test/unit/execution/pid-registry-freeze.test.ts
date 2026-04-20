/**
 * PidRegistry.freeze() — Issue 5 fix
 *
 * Once the registry is frozen (at shutdown), register() must become a no-op
 * so late-spawning retry paths cannot add PIDs that would outlive the process.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { PidRegistry } from "../../../src/execution/pid-registry";

describe("PidRegistry.freeze()", () => {
  let workdir: string;

  beforeEach(() => {
    workdir = `/tmp/nax-pid-freeze-test-${randomUUID()}`;
    mkdirSync(workdir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(workdir)) rmSync(workdir, { recursive: true });
  });

  test("register() before freeze() records the PID", async () => {
    const reg = new PidRegistry(workdir);
    await reg.register(1111);
    expect(reg.getPids()).toEqual([1111]);
  });

  test("register() after freeze() is a no-op — PID is not recorded", async () => {
    const reg = new PidRegistry(workdir);
    reg.freeze();
    await reg.register(2222);
    expect(reg.getPids()).toEqual([]);
  });

  test("isFrozen() reports state", () => {
    const reg = new PidRegistry(workdir);
    expect(reg.isFrozen()).toBe(false);
    reg.freeze();
    expect(reg.isFrozen()).toBe(true);
  });

  test("freeze() is idempotent — second call is harmless", () => {
    const reg = new PidRegistry(workdir);
    reg.freeze();
    reg.freeze();
    expect(reg.isFrozen()).toBe(true);
  });

  test("PIDs registered before freeze survive — killAll can still target them", async () => {
    const reg = new PidRegistry(workdir);
    await reg.register(3333);
    reg.freeze();
    expect(reg.getPids()).toEqual([3333]);
    // After freeze, new registration blocked but existing state preserved.
    await reg.register(4444);
    expect(reg.getPids()).toEqual([3333]);
  });
});
