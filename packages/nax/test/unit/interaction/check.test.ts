/**
 * checkInteraction — the offline interaction-plugin check behind `nax config --json` `interaction` (koda #207).
 *
 * Harness: the telegram env vars are cleared before every test and restored after, so a developer's own
 * NAX_TELEGRAM_TOKEN cannot flip a result (Review focus 1). The telegram plugin's fetch is replaced with one that
 * counts calls and throws, so any network use fails the test that caused it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeNaxConfig } from "@test/helpers";
import type { NaxConfig } from "@/config";
import { NaxError } from "@/errors";
import { _interactionCheckDeps, _telegramPluginDeps, checkInteraction, INTERACTION_INIT_FAILED } from "@/interaction";
import type { InteractionPlugin } from "@/interaction/types";

const TELEGRAM_ENV = ["NAX_TELEGRAM_TOKEN", "TELEGRAM_BOT_TOKEN", "NAX_TELEGRAM_CHAT_ID"] as const;
const savedEnv = new Map<string, string | undefined>();
const realCreatePlugin = _interactionCheckDeps.createPlugin;
const realFetch = _telegramPluginDeps.fetch;
let fetchCalls = 0;

function configFor(plugin: string, pluginConfig: Record<string, unknown> = {}): NaxConfig {
  // A spread, not makeNaxConfig overrides: DeepPartial cannot carry an open Record<string, unknown> plugin config.
  return {
    ...makeNaxConfig(),
    interaction: { plugin, config: pluginConfig, defaults: { timeout: 30000 }, triggers: {} },
  };
}

/** A plugin whose init and destroy are scripted; counts destroy calls. */
function stubPlugin(init: () => Promise<void>, destroy: () => Promise<void> = async () => undefined) {
  const calls = { destroy: 0 };
  const plugin: InteractionPlugin = {
    name: "stub",
    send: async () => undefined,
    receive: async () => {
      throw new Error("not used");
    },
    init,
    destroy: async () => {
      calls.destroy += 1;
      await destroy();
    },
  };
  return { plugin, calls };
}

beforeEach(() => {
  for (const name of TELEGRAM_ENV) {
    savedEnv.set(name, process.env[name]);
    delete process.env[name];
  }
  fetchCalls = 0;
  _telegramPluginDeps.fetch = (async () => {
    fetchCalls += 1;
    throw new Error("the interaction check must not use the network");
  }) as unknown as typeof fetch;
});

afterEach(() => {
  for (const name of TELEGRAM_ENV) {
    const value = savedEnv.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  _interactionCheckDeps.createPlugin = realCreatePlugin;
  _telegramPluginDeps.fetch = realFetch;
});

describe("checkInteraction — skipped and cli", () => {
  test("no interaction section is skipped with a null plugin", async () => {
    expect(await checkInteraction({} as NaxConfig, { headless: true })).toEqual({ plugin: null, status: "skipped" });
  });

  test("Review focus 2: cli is never built — skipped when headless, ok on a terminal", async () => {
    _interactionCheckDeps.createPlugin = () => {
      throw new Error("cli must not be built");
    };
    expect(await checkInteraction(configFor("cli"), { headless: true })).toEqual({ plugin: "cli", status: "skipped" });
    expect(await checkInteraction(configFor("cli"), { headless: false })).toEqual({ plugin: "cli", status: "ok" });
  });

  test("the schema default (cli) is what a config without an interaction override reports", async () => {
    expect(await checkInteraction(makeNaxConfig(), { headless: true })).toEqual({ plugin: "cli", status: "skipped" });
  });
});

describe("checkInteraction — built-in plugins, offline", () => {
  test("telegram with token and chat id in config is ok, and makes no network call", async () => {
    const report = await checkInteraction(configFor("telegram", { botToken: "123456:abc", chatId: "123456789" }), {
      headless: true,
    });
    expect(report).toEqual({ plugin: "telegram", status: "ok" });
    expect(fetchCalls).toBe(0);
  });

  test("telegram with token and chat id from the environment is ok", async () => {
    process.env.NAX_TELEGRAM_TOKEN = "123456:abc";
    process.env.NAX_TELEGRAM_CHAT_ID = "123456789";
    expect(await checkInteraction(configFor("telegram"), { headless: true })).toEqual({
      plugin: "telegram",
      status: "ok",
    });
  });

  test("Review focus 1: telegram without a token (the koda #207 case) fails with TELEGRAM_NOT_CONFIGURED", async () => {
    const report = await checkInteraction(configFor("telegram"), { headless: true });
    expect(report).toMatchObject({ plugin: "telegram", status: "failed", code: "TELEGRAM_NOT_CONFIGURED" });
    expect(report.message).toContain("Telegram plugin requires botToken and chatId");
    expect(fetchCalls).toBe(0);
  });

  test.each([
    ["webhook without a url", "webhook", {}, "WEBHOOK_URL_MISSING"],
    ["webhook without a secret", "webhook", { url: "https://hooks.example.test/nax" }, "WEBHOOK_SECRET_MISSING"],
    ["the removed auto plugin", "auto", {}, "INTERACTION_PLUGIN_REMOVED"],
    ["an unknown plugin", "carrier-pigeon", {}, "INTERACTION_PLUGIN_UNKNOWN"],
    ["a plugin config the schema rejects", "webhook", { url: "not a url" }, INTERACTION_INIT_FAILED],
  ])("%s fails with its code", async (_label, plugin, pluginConfig, code) => {
    expect(await checkInteraction(configFor(plugin, pluginConfig), { headless: true })).toMatchObject({
      plugin,
      status: "failed",
      code,
    });
  });

  test("webhook with a url and a secret is ok (init binds no port)", async () => {
    const config = configFor("webhook", { url: "https://hooks.example.test/nax", secret: "s" });
    expect(await checkInteraction(config, { headless: true })).toEqual({ plugin: "webhook", status: "ok" });
  });
});

describe("checkInteraction — failure handling", () => {
  test("destroy runs after a successful init and after a failed one", async () => {
    const ok = stubPlugin(async () => undefined);
    _interactionCheckDeps.createPlugin = () => ok.plugin;
    await checkInteraction(configFor("stub"), { headless: true });
    expect(ok.calls.destroy).toBe(1);

    const bad = stubPlugin(async () => {
      throw new NaxError("nope", "STUB_NOT_CONFIGURED");
    });
    _interactionCheckDeps.createPlugin = () => bad.plugin;
    expect(await checkInteraction(configFor("stub"), { headless: true })).toMatchObject({
      status: "failed",
      code: "STUB_NOT_CONFIGURED",
    });
    expect(bad.calls.destroy).toBe(1);
  });

  test("Review focus 4: a rejecting destroy is ignored", async () => {
    const { plugin } = stubPlugin(
      async () => undefined,
      async () => {
        throw new Error("teardown failed");
      },
    );
    _interactionCheckDeps.createPlugin = () => plugin;
    expect(await checkInteraction(configFor("stub"), { headless: true })).toEqual({ plugin: "stub", status: "ok" });
  });

  test("Review focus 4: a factory that throws a plain Error is INTERACTION_INIT_FAILED", async () => {
    _interactionCheckDeps.createPlugin = () => {
      throw new Error("factory exploded");
    };
    expect(await checkInteraction(configFor("stub"), { headless: true })).toEqual({
      plugin: "stub",
      status: "failed",
      code: INTERACTION_INIT_FAILED,
      message: "factory exploded",
    });
  });

  test("Review focus 3: the message is redacted and cut to 300 characters", async () => {
    const secret = "sk-abcdefghijklmnopqrstuvwx";
    const { plugin } = stubPlugin(async () => {
      throw new Error(`bad key ${secret} ${"x".repeat(400)}`);
    });
    _interactionCheckDeps.createPlugin = () => plugin;
    const report = await checkInteraction(configFor("stub"), { headless: true });
    expect(report.message).not.toContain(secret);
    expect(report.message).toContain("[REDACTED]");
    expect(report.message?.length).toBe(300);
  });
});
