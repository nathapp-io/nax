import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { withTempDir } from "@test/helpers";
import { fireHook, HOOK_EVENTS, type HooksConfig } from "@/hooks";

describe("on-post-run-action hook", () => {
  test("is a supported hook event", () => {
    expect(HOOK_EVENTS).toContain("on-post-run-action");
  });

  test("exports plugin and action metadata to the hook process", async () => {
    await withTempDir(async (dir) => {
      const output = join(dir, "hook-env.json");
      const script = join(dir, "capture.ts");
      await Bun.write(
        script,
        `await Bun.write(${JSON.stringify(output)}, JSON.stringify({
          pluginName: process.env.NAX_PLUGIN_NAME,
          actionName: process.env.NAX_ACTION_NAME,
          status: process.env.NAX_STATUS,
          reason: process.env.NAX_REASON,
          url: process.env.NAX_RESULT_URL,
        }));`,
      );
      const config: HooksConfig = {
        hooks: { "on-post-run-action": { command: `bun ${script}`, timeout: 10_000 } },
      };

      await fireHook(
        config,
        "on-post-run-action",
        {
          event: "on-post-run-action",
          feature: "payments",
          pluginName: "report-plugin",
          actionName: "publish-report",
          status: "succeeded",
          reason: "published",
          url: "https://example.com/report",
        },
        dir,
      );

      expect(JSON.parse(await Bun.file(output).text())).toEqual({
        pluginName: "report-plugin",
        actionName: "publish-report",
        status: "succeeded",
        reason: "published",
        url: "https://example.com/report",
      });
    });
  });
});
