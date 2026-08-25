/**
 * US-004 — NaxRuntime exposes the storyFixHistory map.
 *
 * Acceptance criterion covered here:
 *   AC 10 — createRuntime constructs a storyFixHistory and repeated reads return the same instance
 */

import { afterEach, describe, expect, test } from "bun:test";
import { makeTestRuntime } from "@test/helpers";
import { DEFAULT_CONFIG } from "@/config";
import { createRuntime, type NaxRuntime } from "@/runtime";

const runtimes: NaxRuntime[] = [];

function trackedRuntime(): NaxRuntime {
  const rt = createRuntime(DEFAULT_CONFIG, "/tmp/test", { featureName: "_test" });
  runtimes.push(rt);
  return rt;
}

afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map((r) => r.close()));
});

describe("NaxRuntime.storyFixHistory (US-004)", () => {
  test("[US-004 AC 10] createRuntime exposes a storyFixHistory Map (initial state)", () => {
    const rt = trackedRuntime();
    expect(rt.storyFixHistory).toBeInstanceOf(Map);
    expect(rt.storyFixHistory.size).toBe(0);
  });

  test("[US-004 AC 10] repeated reads of storyFixHistory return the same instance (identity)", () => {
    const rt = trackedRuntime();
    const first = rt.storyFixHistory;
    const second = rt.storyFixHistory;
    expect(second).toBe(first);
  });

  test("[US-004 AC 10] makeTestRuntime also exposes a storyFixHistory Map", () => {
    const rt = makeTestRuntime();
    runtimes.push(rt);
    expect(rt.storyFixHistory).toBeInstanceOf(Map);
    expect(rt.storyFixHistory.size).toBe(0);
  });
});
