import { afterEach, describe, expect, mock, test } from "bun:test";
import { makeMockRuntime, makeNaxConfig } from "@test/helpers";
import { setupBotRuntime } from "@/bot";
import { _botRunSetupDeps } from "@/bot/run-setup";
import { NaxError } from "@/errors";

const original = { ..._botRunSetupDeps };
afterEach(() => Object.assign(_botRunSetupDeps, original));

describe("setupBotRuntime", () => {
  test("AC-1/2/3: validates once, checks native credentials and installs canonical handlers in order", async () => {
    const events: string[] = [];
    const config = makeNaxConfig();
    const runtime = makeMockRuntime();
    const validate = mock(async () => {
      events.push("validate");
    });
    const native = mock(async () => {
      events.push("native");
    });
    const handlers = [{ name: "test" }];
    const rules = mock(async () => {
      events.push("rules");
      return handlers;
    });
    const configure = mock(() => {
      events.push("configure");
    });
    runtime.agentManager.validateCredentials = validate;
    runtime.sessionManager.configureLoopHandlers = configure;
    Object.assign(_botRunSetupDeps, { assertDefaultNativeCredentials: native, configureRunRules: rules });
    try {
      await setupBotRuntime(runtime, config, "/checkout");
      expect(validate).toHaveBeenCalledTimes(1);
      expect(native).toHaveBeenCalledWith(config);
      expect(rules).toHaveBeenCalledWith({ config, workdir: "/checkout", pluginHandlers: [] });
      expect(configure).toHaveBeenCalledWith(handlers);
      expect(events).toEqual(["validate", "native", "rules", "configure"]);
    } finally {
      await runtime.close();
    }
  });

  test.each([
    ["validate", "CREDENTIALS_MISSING"],
    ["native", "NATIVE_CREDENTIALS_MISSING"],
    ["rules", "PROJECT_CONTEXT_FILE_NOT_FOUND"],
  ])("AC-4/5/6: propagates %s rejection without configuring handlers", async (stage, code) => {
    const runtime = makeMockRuntime();
    const error = new NaxError("[bot] setup failed", code, { stage: "bot" });
    const fail = async () => {
      throw error;
    };
    const native = mock(async () => {});
    const rules = mock(async () => []);
    const configure = mock(() => {});
    runtime.agentManager.validateCredentials = stage === "validate" ? fail : async () => {};
    runtime.sessionManager.configureLoopHandlers = configure;
    Object.assign(_botRunSetupDeps, {
      assertDefaultNativeCredentials: stage === "native" ? fail : native,
      configureRunRules: stage === "rules" ? fail : rules,
    });
    try {
      await expect(setupBotRuntime(runtime, makeNaxConfig(), "/checkout")).rejects.toBe(error);
      expect(configure).not.toHaveBeenCalled();
      if (stage === "validate") {
        expect(native).not.toHaveBeenCalled();
        expect(rules).not.toHaveBeenCalled();
      }
    } finally {
      await runtime.close();
    }
  });
});
