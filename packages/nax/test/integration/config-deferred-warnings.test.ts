import { afterEach, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { loadConfig } from "@/config";
import * as logging from "@/logger/logger";
import { cleanupTempDir, makeTempDir } from "../helpers/temp";

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
