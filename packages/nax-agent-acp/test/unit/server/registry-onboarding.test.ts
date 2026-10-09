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
        return { options: written ? WITH_MODEL : NO_MODEL };
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
      reloadOptions: async () => ({ options: WITH_MODEL }),
      ensureCredentials: async (model) => {
        checked.push(model);
      },
    });
    await s.registry.create(s.input());
    expect(checked).toEqual(["acme/m-1"]);
  });

  test("a reload that still finds no model is auth_required, and a failing reload is too", async () => {
    const still = setupRegistry(dir, NO_MODEL, { reloadOptions: async () => ({ options: NO_MODEL }) });
    expect((await failure(still.registry.create(still.input()))).code).toBe(-32000);
    const broken = setupRegistry(dir, NO_MODEL, {
      reloadOptions: async () => Promise.reject(new Error("unreadable")),
    });
    expect((await failure(broken.registry.create(broken.input()))).code).toBe(-32000);
  });

  test("a config problem found by the reload is named in the auth_required message", async () => {
    const s = setupRegistry(dir, NO_MODEL, {
      reloadOptions: async () => ({ problem: "ignoring /cfg/config.json: invalid JSON; using built-in defaults" }),
    });
    const error = await failure(s.registry.create(s.input()));
    expect(error.code).toBe(-32000);
    expect(error.message).toContain("config.json could not be used: ignoring /cfg/config.json: invalid JSON");
  });

  test("a throwing reload is logged as a warning and named in the message", async () => {
    const s = setupRegistry(dir, NO_MODEL, {
      reloadOptions: async () => Promise.reject(new Error("EACCES: permission denied")),
    });
    const error = await failure(s.registry.create(s.input()));
    expect(error.message).toContain("config.json could not be used: EACCES");
    expect(s.lines.some((l) => l.level === "warn" && l.message.includes("could not re-read"))).toBe(true);
  });

  test("the message without a config problem reads cleanly after the login hint wrapper", async () => {
    const s = setupRegistry(dir, NO_MODEL);
    const error = await failure(s.registry.create(s.input()));
    expect(error.message).toContain(
      "no model configured: log in to pick one, or set models.native.balanced in config.json / NAX_AGENT_MODEL. Log in with",
    );
  });

  test("a configured model is used as is; the options are not re-read", async () => {
    let reads = 0;
    const s = setupRegistry(dir, WITH_MODEL, {
      reloadOptions: async () => {
        reads += 1;
        return {};
      },
    });
    await s.registry.create(s.input());
    expect(reads).toBe(0);
  });
});
