import { afterEach, describe, expect, test } from "bun:test";
import { getInitializedLogger, getSafeLogger, initLogger, resetLogger } from "@/logger";

describe("getInitializedLogger", () => {
  afterEach(() => resetLogger());

  test("is null before initLogger runs, where getSafeLogger substitutes a silent logger", () => {
    resetLogger();
    expect(getInitializedLogger()).toBeNull();
    expect(getSafeLogger()).not.toBeNull();
  });

  test("is the instance initLogger created", () => {
    resetLogger();
    const logger = initLogger({ level: "silent" });
    expect(getInitializedLogger()).toBe(logger);
  });

  test("is null again after resetLogger", () => {
    resetLogger();
    initLogger({ level: "silent" });
    resetLogger();
    expect(getInitializedLogger()).toBeNull();
  });
});
