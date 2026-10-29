import { afterEach, describe, expect, mock, test } from "bun:test";
import { assertDefined, makeLogger, makeNaxConfig } from "@test/helpers";
import { _interactionInitDeps, initInteractionChain } from "@/interaction/init";
import { ChatAskPlugin } from "@/interaction/plugins/chat";
import type { InteractionPlugin } from "@/interaction/types";

const original = { ..._interactionInitDeps };
const options = { chatAsksDir: "/tmp/job.asks", chatAskSecret: new Uint8Array(32).fill(7) };
afterEach(() => Object.assign(_interactionInitDeps, original));
function config(plugin: "cli" | "telegram" | "webhook" = "cli") {
  return makeNaxConfig({ interaction: { plugin, config: { token: "test" }, defaults: { chatAskFallbackMs: 1234 } } });
}
function fallback() {
  return {
    name: "telegram",
    init: mock(async (_config: Record<string, unknown>) => {}),
    send: mock(async () => {}),
    receive: mock(async (requestId: string) => ({
      requestId,
      action: "skip" as const,
      respondedBy: "timeout",
      respondedAt: 0,
    })),
  } satisfies InteractionPlugin;
}

describe("initInteractionChain chat asks", () => {
  test("AC-1/2/5 selects only chat for headless CLI without constructing CLI", async () => {
    const create = mock(original.createInteractionPlugin);
    _interactionInitDeps.createInteractionPlugin = create;
    const chain = await initInteractionChain(config(), true, options);
    const primary = chain?.getPrimary();
    expect(primary?.name).toBe("chat");
    expect(create).not.toHaveBeenCalled();
    expect(primary).toBeInstanceOf(ChatAskPlugin);
    if (primary instanceof ChatAskPlugin) expect(primary.fallbackDelayMs).toBe(1234);
    await chain?.destroy();
  });
  test.each(["telegram", "webhook"] as const)(
    "AC-3/4 initializes configured %s fallback with its own config",
    async (name) => {
      const plugin = fallback();
      const create = mock(() => plugin);
      _interactionInitDeps.createInteractionPlugin = create;
      const cfg = config(name);
      assertDefined(cfg.interaction, "interaction fixture");
      const chain = await initInteractionChain(cfg, true, options);
      expect(create).toHaveBeenCalledWith(name);
      expect(plugin.init).toHaveBeenCalledTimes(1);
      expect(plugin.init).toHaveBeenCalledWith(cfg.interaction.config);
      expect(chain?.getPrimary()?.name).toBe("chat");
      await chain?.destroy();
    },
  );
  test("AC-6 preserves headless CLI without options", async () => {
    expect(await initInteractionChain(config(), true)).toBeNull();
  });
  test("AC-10/15 warns before taking the original headless CLI path without a secret", async () => {
    const logger = makeLogger();
    _interactionInitDeps.getSafeLogger = () => logger;
    expect(await initInteractionChain(config(), true, { chatAsksDir: options.chatAsksDir })).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith("interaction", expect.stringContaining("secret"));
  });
  test("AC-15 warns before initializing the original non-chat plugin", async () => {
    const logger = makeLogger();
    _interactionInitDeps.getSafeLogger = () => logger;
    const plugin = fallback();
    _interactionInitDeps.createInteractionPlugin = mock(() => {
      expect(logger.warn).toHaveBeenCalledTimes(1);
      return plugin;
    });
    const chain = await initInteractionChain(config("telegram"), true, { chatAsksDir: options.chatAsksDir });
    expect(chain?.getPrimary()?.name).toBe("telegram");
    await chain?.destroy();
  });
});
