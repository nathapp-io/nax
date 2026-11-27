import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { resolveRegisteredLogPath } from "@/utils/registered-log";

describe("resolveRegisteredLogPath", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTempDir("registered-log-");
  });
  afterEach(() => cleanupTempDir(dir));

  test("returns the validated real target, so retargeting the symlink afterwards cannot redirect readers", () => {
    const events = join(dir, "events");
    const outside = join(dir, "outside");
    mkdirSync(events);
    mkdirSync(outside);
    writeFileSync(join(events, "real.jsonl"), "inside");
    writeFileSync(join(outside, "secret.jsonl"), "outside");
    const link = join(events, "r1.jsonl");
    symlinkSync(join(events, "real.jsonl"), link);

    const resolved = resolveRegisteredLogPath({ runId: "r1", eventsDir: events });
    unlinkSync(link);
    symlinkSync(join(outside, "secret.jsonl"), link);

    expect(resolved).toBe(realpathSync(join(events, "real.jsonl")));
  });
});
