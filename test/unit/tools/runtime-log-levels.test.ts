/**
 * Unit tests for coding-tool console signal (log level + failure reason).
 *
 * Every outcome is still recorded — the audit sink and the JSONL are unchanged.
 * What differs is the level, which is what the console formatter filters on:
 *
 *  - `ok`                        -> debug (bulk; 1020 of 1165 calls in one run)
 *  - `error` on a routineErrors  -> debug (RunCommand: the agent's own gate
 *    tool                                 loop, where a non-zero exit is TDD red)
 *  - `error` on any other tool   -> warn  (a malformed Read/Edit/GitCommit)
 *  - `denied`                    -> warn, or error when the policy flagged a
 *                                   breach (a path escaping the root)
 *
 * The reason travels under the `error` data key so the formatter's existing
 * readFailureReason() renders it inline — previously these lines printed as a
 * bare "coding-tool invoked" with no tool name and no reason at all, so 145
 * visible failures in one observed run identified neither.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLogger } from "@test/helpers";
import { _codingToolDeps, type CodingTool, compileToolPolicy, createCodingToolRuntime } from "@/tools";

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "nax-tool-levels-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "const a = 1;\n");
});

/** A stub tool whose single result is fixed, so only the logging is under test. */
function makeTool(name: string, result: { content: string; isError?: boolean }, routineErrors?: boolean): CodingTool {
  return {
    name,
    description: name,
    inputSchema: { type: "object", properties: {} },
    scope: { pathFields: [] },
    ...(routineErrors === undefined ? {} : { routineErrors }),
    run: async () => result,
  };
}

describe("coding-tool log levels", () => {
  let logger: ReturnType<typeof makeLogger>;
  let orig: typeof _codingToolDeps.getLogger;

  beforeEach(() => {
    logger = makeLogger();
    orig = _codingToolDeps.getLogger;
    _codingToolDeps.getLogger = () => logger;
  });

  afterEach(() => {
    _codingToolDeps.getLogger = orig;
  });

  const records = () => logger.calls.filter((c) => c.stage === "coding-tool");

  function runtimeWith(tool: CodingTool) {
    return createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: tool.name, patterns: ["*"] }], root),
      storyId: "US-001",
      extraTools: [tool],
    });
  }

  test("a successful call is recorded at debug, not info", async () => {
    const rt = runtimeWith(makeTool("Ok", { content: "fine" }));
    const outcome = await rt.callTool("Ok", {});

    expect(outcome.kind).toBe("ok");
    expect(records()).toHaveLength(1);
    expect(records()[0]?.level).toBe("debug");
    expect(records()[0]?.data?.tool).toBe("Ok");
    expect(records()[0]?.data?.outcome).toBe("ok");
  });

  test("an error on an ordinary tool warns and carries the reason", async () => {
    const rt = runtimeWith(makeTool("Boom", { content: "no such file: a.ts", isError: true }));
    const outcome = await rt.callTool("Boom", {});

    expect(outcome.kind).toBe("error");
    expect(records()[0]?.level).toBe("warn");
    expect(records()[0]?.data?.tool).toBe("Boom");
    expect(records()[0]?.data?.error).toBe("no such file: a.ts");
  });

  test("the message names the tool and outcome so the console line is legible", async () => {
    const rt = runtimeWith(makeTool("Boom", { content: "bad", isError: true }));
    await rt.callTool("Boom", {});

    expect(records()[0]?.message).toBe("Boom error");
  });

  test("an error on a routineErrors tool stays at debug", async () => {
    const rt = runtimeWith(makeTool("Runner", { content: "exit 1\nlint failed", isError: true }, true));
    const outcome = await rt.callTool("Runner", {});

    expect(outcome.kind).toBe("error");
    expect(records()[0]?.level).toBe("debug");
  });

  test("a routineErrors error is still recorded, with its reason", async () => {
    const rt = runtimeWith(makeTool("Runner", { content: "exit 1", isError: true }, true));
    await rt.callTool("Runner", {});

    expect(records()).toHaveLength(1);
    expect(records()[0]?.data?.outcome).toBe("error");
    expect(records()[0]?.data?.error).toBe("exit 1");
  });

  test("a thrown tool is a warning, carrying the thrown message", async () => {
    const thrower: CodingTool = {
      ...makeTool("Thrower", { content: "" }),
      run: async () => {
        throw new Error("kaboom");
      },
    };
    const rt = runtimeWith(thrower);
    const outcome = await rt.callTool("Thrower", {});

    expect(outcome.kind).toBe("error");
    expect(records()[0]?.level).toBe("warn");
    expect(records()[0]?.data?.error).toBe("kaboom");
  });

  test("an unknown tool is denied at warn with the reason", async () => {
    const rt = runtimeWith(makeTool("Ok", { content: "fine" }));
    const outcome = await rt.callTool("Nope", {});

    expect(outcome.kind).toBe("denied");
    expect(records()[0]?.level).toBe("warn");
    expect(records()[0]?.message).toBe("Nope denied");
    expect(String(records()[0]?.data?.error)).toContain("unknown tool");
  });

  test("a containment breach is an error, not a warning", async () => {
    // A path escaping the root can indicate prompt injection, so it is the one
    // tool outcome that earns the error level.
    const rt = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Read", patterns: ["*"] }], root),
      storyId: "US-001",
    });
    const outcome = await rt.callTool("Read", { path: "../elsewhere/secret.txt" });

    expect(outcome.kind).toBe("denied");
    const denial = records().find((c) => c.data?.outcome === "denied");
    expect(denial?.level).toBe("error");
    expect(denial?.data?.error).toBeTruthy();
  });

  test("an ordinary pattern denial is a warning, not an error", async () => {
    const rt = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Read", patterns: ["src/**"] }], root),
      storyId: "US-001",
    });
    const outcome = await rt.callTool("Write", { path: "src/a.ts", content: "x" });

    expect(outcome.kind).toBe("denied");
    expect(records()[0]?.level).toBe("warn");
  });

  test("storyId is still the first data key, per the structured-log convention", async () => {
    const rt = runtimeWith(makeTool("Ok", { content: "fine" }));
    await rt.callTool("Ok", {});

    expect(Object.keys(records()[0]?.data ?? {})[0]).toBe("storyId");
  });
});
