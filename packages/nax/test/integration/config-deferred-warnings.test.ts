import { afterEach, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import * as configExports from "@/config";
import { loadConfig } from "@/config";
import * as logging from "@/logger/logger";
import { cleanupTempDir, makeTempDir } from "../helpers/temp";

test("AC-17: loadConfig preserves the tui permission block for posture resolution", async () => {
  projectDir = makeTempDir("nax-config-tui-");
  await Bun.write(
    join(projectDir, ".nax/config.json"),
    JSON.stringify({
      execution: { permissions: { tui: { bashApproval: "gated", ask: ["Write"], deny: ["Delete(src/**)"] } } },
    }),
  );
  const config = await loadConfig(projectDir);
  expect(configExports.resolveTuiPermissions(config)).toEqual({
    bashApproval: "gated",
    askRules: ["Write"],
    denyRules: ["Delete(src/**)"],
  });
});

let projectDir: string | undefined;
afterEach(() => {
  logging.resetLogger();
  logging._resetDeferredWarnings?.();
  if (projectDir) cleanupTempDir(projectDir);
});

test("AC-8: loadConfig defers the pipeline deprecation until logging starts", async () => {
  logging.resetLogger();
  logging._resetDeferredWarnings?.();
  projectDir = makeTempDir("nax-config-deferred-");
  await Bun.write(join(projectDir, ".nax/config.json"), JSON.stringify({ execution: { mode: "pipeline" } }));
  const warn = spyOn(logging.Logger.prototype, "warn");
  try {
    const config = await loadConfig(projectDir);
    expect(config.execution.mode).toBe("pipeline");
    warn.mockClear();
    const logger = logging.initLogger({ level: "warn", suppressConsole: true });
    expect(warn).toHaveBeenCalledWith("config", expect.stringContaining('execution.mode "pipeline" is deprecated'));
    expect(warn.mock.contexts.every((context) => context === logger)).toBe(true);
  } finally {
    warn.mockRestore();
  }
});
