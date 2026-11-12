/**
 * RunCommand's declared-command runner port (S1 spec section 4.2, port 7): the
 * tool never imports nax's quality runner; the caller supplies one.
 */
import { describe, expect, test } from "bun:test";
import type { CodingTool } from "#src/tools/index";
import { createRunCommandTool, type DeclaredCommandRequest } from "#src/tools/run-command";
import { withTempDir } from "#test/helpers/index";

const ctx = (root: string) => ({ root, resolvedPaths: [], maxBytes: 4096, maxFileBytes: 1024 });

describe("RunCommand — declared-command runner port", () => {
  test("hands the declared command, cwd, stripped env and origin to the supplied runner", async () => {
    await withTempDir(async (root) => {
      const seen: DeclaredCommandRequest[] = [];
      const tool = createRunCommandTool(new Map([["lint", "bun lint"]]), {
        commandCwd: root,
        stripEnvVars: ["SECRET"],
        runDeclaredCommand: async (request) => {
          seen.push(request);
          return { success: true, exitCode: 0, output: "clean" };
        },
      });
      const result = await tool.run({ command: "lint" }, ctx(root));
      expect(seen).toEqual([
        { commandName: "lint", command: "bun lint", workdir: root, stripEnvVars: ["SECRET"], origin: "agent-tool" },
      ]);
      expect(result).toEqual({ content: "exit 0\nclean", isError: false });
    });
  });

  test("answers exit 1 without spawning when no runner was configured", async () => {
    await withTempDir(async (root) => {
      const tool = createRunCommandTool(new Map([["lint", "bun lint"]]), { commandCwd: root });
      const result = await tool.run({ command: "lint" }, ctx(root));
      expect(result.isError).toBe(true);
      expect(result.content).toBe("exit 1\nno declared-command runner is configured for this session");
    });
  });
});

// US-005: the values description promised `{ files: "a.test.ts" }` to every
// project, including one whose scoped test template declares no `{{files}}`
// (e.g. `npx turbo test --filter=[HEAD^1]`). The model then sent a value no
// declared command accepts, and `substituteCommandSpec` refused it. The
// description now advertises files only when some declared template uses it.
describe("RunCommand — the values description follows the declared placeholders", () => {
  const tool = (entries: [string, string | string[]][]): CodingTool =>
    createRunCommandTool(new Map<string, string | string[]>(entries));

  /** One property of the schema, read through descriptors so nothing is cast. */
  const propertyValue = (built: CodingTool, field: string): unknown => {
    const properties: unknown = built.inputSchema.properties;
    if (typeof properties !== "object" || properties === null) throw new Error("expected inputSchema.properties");
    return Object.getOwnPropertyDescriptor(properties, field)?.value;
  };

  /** One field of a schema property (`description`, `enum`, ...), likewise. */
  const fieldOf = (entry: unknown, field: string): unknown => {
    if (typeof entry !== "object" || entry === null) throw new Error(`expected a schema property holding ${field}`);
    return Object.getOwnPropertyDescriptor(entry, field)?.value;
  };

  const valuesDescription = (built: CodingTool): unknown => fieldOf(propertyValue(built, "values"), "description");

  const NO_PLACEHOLDER_DESCRIPTION = "None of the declared commands take placeholders: omit values.";

  test("AC-1: a {{files}} template keeps the files examples", () => {
    const built = tool([
      ["test", "bun test"],
      ["testScoped", "bun test {{files}}"],
    ]);
    const description = valuesDescription(built);
    expect(typeof description).toBe("string");
    expect(description).toContain('{ files: "a.test.ts" }');
    expect(description).not.toBe(NO_PLACEHOLDER_DESCRIPTION);
  });

  test("AC-2: no template declares a placeholder, so the description says to omit values", () => {
    const built = tool([
      ["test", "npx turbo test"],
      ["testScoped", "npx turbo test --filter=[HEAD^1]"],
    ]);
    expect(valuesDescription(built)).toBe(NO_PLACEHOLDER_DESCRIPTION);
  });

  test("AC-3: the command enum is unchanged by the values wording", () => {
    const built = tool([
      ["test", "npx turbo test"],
      ["testScoped", "npx turbo test --filter=[HEAD^1]"],
    ]);
    expect(fieldOf(propertyValue(built, "command"), "enum")).toEqual(["test", "testScoped"]);
  });

  test("AC-4: a command list's {{files}} entry keeps the files examples", () => {
    const built = tool([["check", ["tsc --noEmit", "bun test {{files}}"]]]);
    const description = valuesDescription(built);
    expect(typeof description).toBe("string");
    expect(description).toContain('{ files: "a.test.ts" }');
  });

  test("a list where no entry declares a placeholder also says to omit values", () => {
    const built = tool([["check", ["tsc --noEmit", "biome check"]]]);
    expect(valuesDescription(built)).toBe(NO_PLACEHOLDER_DESCRIPTION);
  });
});

describe("RunCommand — input shape refusals", () => {
  const neverRun = async (): Promise<never> => {
    throw new Error("the runner must not be reached");
  };

  test("refuses a call that supplies both command and argv", async () => {
    await withTempDir(async (root) => {
      const tool = createRunCommandTool(new Map([["lint", "bun lint"]]), {
        commandCwd: root,
        runDeclaredCommand: neverRun,
      });
      const result = await tool.run({ command: "lint", argv: ["bun", "lint"] }, ctx(root));
      expect(result).toEqual({ content: "supply exactly one of command or argv, not both", isError: true });
    });
  });

  test("refuses values sent as a string, naming the type it got", async () => {
    await withTempDir(async (root) => {
      const tool = createRunCommandTool(new Map([["test", "bun test {{files}}"]]), {
        commandCwd: root,
        runDeclaredCommand: neverRun,
      });
      const result = await tool.run({ command: "test", values: "a.test.ts" }, ctx(root));
      expect(result.isError).toBe(true);
      expect(result.content).toStartWith('"values" must be an object mapping placeholder names to values');
      expect(result.content).toContain("got a string instead");
    });
  });
});
