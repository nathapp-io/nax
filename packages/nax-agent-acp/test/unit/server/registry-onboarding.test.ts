import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { RequestError } from "@agentclientprotocol/sdk";
import { cleanupTempDir, makeTempDir } from "@nathapp/nax-test-kit/bun/temp";
import type { ServerOptions } from "#src/server/options";
import { OPTIONS, setupRegistry } from "#test/helpers/registry-setup";

let dir: string;
beforeEach(() => {
  dir = makeTempDir("acp-registry-onboarding-");
});
afterEach(() => cleanupTempDir(dir));

const { defaultModel: _model, ...BARE } = OPTIONS;
const NO_MODEL: ServerOptions = { ...BARE, tiers: [] };
const WITH_MODEL: ServerOptions = {
  ...OPTIONS,
  defaultModel: "acme/m-1",
  tiers: [{ tier: "balanced", model: "acme/m-1" }],
};

async function failure(promise: Promise<unknown>): Promise<RequestError> {
  const caught = await promise.catch((e: unknown) => e);
  if (caught instanceof RequestError) return caught;
  throw new Error(`expected a RequestError, got ${String(caught)}`);
}

describe("session/new without a configured model", () => {
  test("re-reads the options, so a retry after login works without a restart", async () => {
    let written = false;
    let reads = 0;
    const s = setupRegistry(dir, NO_MODEL, {
      reloadOptions: async () => {
        reads += 1;
        return written ? WITH_MODEL : NO_MODEL;
      },
    });
    const first = await failure(s.registry.create(s.input()));
    expect(first.code).toBe(-32000);
    expect(s.opened).toEqual([]);
    written = true; // the login wrote models.native.balanced
    const created = await s.registry.create(s.input());
    expect(reads).toBe(2);
    expect(s.opened[0]).toMatchObject({ model: "acme/m-1" });
    const model = created.configOptions.find((o) => o.id === "model");
    expect(model).toMatchObject({ currentValue: "acme/m-1", options: [{ value: "acme/m-1", name: "balanced" }] });
  });

  test("the credential pre-flight then runs for the new model", async () => {
    const checked: string[] = [];
    const s = setupRegistry(dir, NO_MODEL, {
      reloadOptions: async () => WITH_MODEL,
      ensureCredentials: async (model) => {
        checked.push(model);
      },
    });
    await s.registry.create(s.input());
    expect(checked).toEqual(["acme/m-1"]);
  });

  test("a reload that still finds no model is auth_required, and a failing reload is too", async () => {
    const still = setupRegistry(dir, NO_MODEL, { reloadOptions: async () => NO_MODEL });
    expect((await failure(still.registry.create(still.input()))).code).toBe(-32000);
    const broken = setupRegistry(dir, NO_MODEL, {
      reloadOptions: async () => Promise.reject(new Error("unreadable")),
    });
    expect((await failure(broken.registry.create(broken.input()))).code).toBe(-32000);
  });

  test("a configured model is used as is; the options are not re-read", async () => {
    let reads = 0;
    const s = setupRegistry(dir, WITH_MODEL, {
      reloadOptions: async () => {
        reads += 1;
        return undefined;
      },
    });
    await s.registry.create(s.input());
    expect(reads).toBe(0);
  });
});
