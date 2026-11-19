/**
 * US-008: the blocking set `nax workflow status` reads. It is config, resolved for the directory the
 * command was given, and a config the loader rejects must not stop the status report: the default set
 * is what the rest of the bot falls back to as well.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { withTempDir } from "@test/helpers";
import { _workflowForgeDeps } from "@/cli/workflow-forge";
import { DEFAULT_BLOCKING_TRIGGERS } from "@/workflow/blocking-findings";

const writeConfig = (dir: string, config: unknown): Promise<number> =>
  Bun.write(join(dir, ".nax", "config.json"), JSON.stringify(config));

describe("_workflowForgeDeps.readBlockingTriggers", () => {
  test("US-008 AC-8 returns the default set when the config load rejects", async () => {
    await withTempDir(async (dir) => {
      // `blockingTriggers: []` is refused by the schema, so the load throws rather than returning.
      await writeConfig(dir, { bot: { blockingTriggers: [] } });
      expect(await _workflowForgeDeps.readBlockingTriggers(dir)).toEqual(DEFAULT_BLOCKING_TRIGGERS);
    });
  });

  test("returns the set the project configures", async () => {
    await withTempDir(async (dir) => {
      await writeConfig(dir, { bot: { blockingTriggers: ["normal", "manual"] } });
      expect(await _workflowForgeDeps.readBlockingTriggers(dir)).toEqual(["normal", "manual"]);
    });
  });

  test("returns the default set for a project with no bot config", async () => {
    await withTempDir(async (dir) => {
      expect(await _workflowForgeDeps.readBlockingTriggers(dir)).toEqual(DEFAULT_BLOCKING_TRIGGERS);
    });
  });
});
