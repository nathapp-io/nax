import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type NaxConfig, NaxConfigSchema } from "@/config";
import { createRuntime } from "@/runtime";

const runtimes: { close(): Promise<void> }[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map((r) => r.close()));
  await Promise.allSettled(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const workdir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "nax-mcp-runtime-"));
  dirs.push(dir);
  return dir;
};

const configWith = (servers: Record<string, unknown>): NaxConfig => ({
  ...NaxConfigSchema.parse({ name: "probe", mcp: { servers } }),
  version: 1,
});

describe("createRuntime MCP wiring", () => {
  test("no mcp block means no providers", async () => {
    const runtime = createRuntime({ ...NaxConfigSchema.parse({ name: "probe" }), version: 1 }, await workdir());
    runtimes.push(runtime);
    expect(runtime.toolProviders).toEqual([]);
  });

  test("a configured server becomes one provider, id = server id", async () => {
    const runtime = createRuntime(configWith({ memory: { command: "fake", stages: ["run"] } }), await workdir());
    runtimes.push(runtime);
    expect(runtime.toolProviders.map((p) => p.id)).toEqual(["memory"]);
    expect(runtime.toolProviders[0]?.stages).toEqual(["run"]);
  });

  test("a disabled server contributes no provider", async () => {
    const runtime = createRuntime(
      configWith({ memory: { command: "fake", stages: ["run"], enabled: false } }),
      await workdir(),
    );
    runtimes.push(runtime);
    expect(runtime.toolProviders).toEqual([]);
  });

  test("construction spawns nothing — connection is lazy", async () => {
    // `command` cannot exist; if construction connected eagerly this would warn
    // or throw. It must simply build.
    const runtime = createRuntime(
      configWith({ memory: { command: "definitely-not-a-real-binary-xyz", stages: ["*"] } }),
      await workdir(),
    );
    runtimes.push(runtime);
    expect(runtime.toolProviders.length).toBe(1);
  });

  test("close() is idempotent with a pool attached", async () => {
    const runtime = createRuntime(configWith({ memory: { command: "fake", stages: ["run"] } }), await workdir());
    await runtime.close();
    await runtime.close();
  });
});
