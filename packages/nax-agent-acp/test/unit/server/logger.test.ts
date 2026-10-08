import { describe, expect, test } from "bun:test";
import { stderrLogger } from "#src/server/logger";

function capture(level: "info" | "debug") {
  const lines: string[] = [];
  return { logger: stderrLogger(level, (text) => lines.push(text)), lines };
}

describe("stderrLogger", () => {
  test("writes one JSON line per entry with level, stage, message and data", () => {
    const { logger, lines } = capture("info");
    logger.warn("config", "ignoring file", { path: "/x" });
    expect(lines).toEqual([
      `${JSON.stringify({ level: "warn", stage: "config", message: "ignoring file", data: { path: "/x" } })}\n`,
    ]);
  });

  test("info drops debug; debug keeps everything", () => {
    const info = capture("info");
    info.logger.debug("s", "hidden");
    info.logger.error("s", "shown");
    expect(info.lines).toHaveLength(1);
    const debug = capture("debug");
    debug.logger.debug("s", "shown");
    debug.logger.info("s", "shown");
    expect(debug.lines).toHaveLength(2);
  });

  test("unserialisable data never throws; the message still lands", () => {
    const { logger, lines } = capture("info");
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => logger.info("s", "with cycle", circular)).not.toThrow();
    expect(JSON.parse(lines[0] ?? "")).toEqual({
      level: "info",
      stage: "s",
      message: "with cycle",
      data: "[unserialisable]",
    });
  });
});
