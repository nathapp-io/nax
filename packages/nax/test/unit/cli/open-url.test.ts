import { afterEach, describe, expect, test } from "bun:test";
import { _openUrlDeps, openUrl } from "@/cli/open-url";

const realSpawn = _openUrlDeps.spawn;
const realPlatform = _openUrlDeps.platform;

afterEach(() => {
  _openUrlDeps.spawn = realSpawn;
  _openUrlDeps.platform = realPlatform;
});

function capture(platform: string) {
  const calls: (readonly string[])[] = [];
  _openUrlDeps.platform = () => platform;
  _openUrlDeps.spawn = (command) => {
    calls.push(command);
  };
  return calls;
}

describe("openUrl", () => {
  test("uses the macOS opener", () => {
    const calls = capture("darwin");
    openUrl("https://example.test/a");
    expect(calls).toEqual([["open", "https://example.test/a"]]);
  });

  test("uses xdg-open on linux", () => {
    const calls = capture("linux");
    openUrl("https://example.test/a");
    expect(calls).toEqual([["xdg-open", "https://example.test/a"]]);
  });

  test("keeps the empty title argument on windows", () => {
    const calls = capture("win32");
    openUrl("https://example.test/a");
    expect(calls).toEqual([["cmd", "/c", "start", "", "https://example.test/a"]]);
  });

  test("passes the url as its own argv entry, never through a shell", () => {
    const calls = capture("darwin");
    openUrl("https://example.test/a; rm -rf /");
    expect(calls[0]).toEqual(["open", "https://example.test/a; rm -rf /"]);
  });

  test("a spawn failure is swallowed: the url is already on screen", () => {
    _openUrlDeps.platform = () => "darwin";
    _openUrlDeps.spawn = () => {
      throw new Error("no opener");
    };
    expect(() => openUrl("https://example.test/a")).not.toThrow();
  });
});
