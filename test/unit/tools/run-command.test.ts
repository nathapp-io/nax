import { describe, expect, test } from "bun:test";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withTempDir } from "@test/helpers";
import { compileToolPolicy } from "@/tools/policy";
import { createRunCommandTool, substituteCommand } from "@/tools/run-command";
import { createCodingToolRuntime } from "@/tools/runtime";

describe("substituteCommand", () => {
  test("substitutes a declared placeholder", () => {
    expect(substituteCommand("bun test {{files}}", { files: "a.test.ts" })).toBe("bun test 'a.test.ts'");
  });

  test("quotes the substituted value so a metacharacter cannot escape", () => {
    const out = substituteCommand("bun test {{files}}", { files: "a.ts; rm -rf /" });
    expect(out).toBe("bun test 'a.ts; rm -rf /'");
  });

  test("quotes an embedded single quote rather than closing the string", () => {
    const out = substituteCommand("bun test {{files}}", { files: "a'; id; '.ts" });
    expect(out).toBe(`bun test 'a'\\''; id; '\\''.ts'`);
  });

  test("preserves an env-assignment prefix, which is why this is a shell string", () => {
    expect(substituteCommand("CI=1 bun test {{files}}", { files: "a.ts" })).toBe("CI=1 bun test 'a.ts'");
  });

  test("refuses a placeholder the template does not declare, naming the declared set", () => {
    expect(substituteCommand("bun test {{files}}", { nope: "x" })).toEqual({
      error: 'value "nope" is not a placeholder in this command (declared: files)',
    });
  });

  test("refuses when a declared placeholder is left unfilled, naming the declared set", () => {
    expect(substituteCommand("bun test {{files}}", {})).toEqual({
      error: "placeholder {{files}} has no value (declared: files)",
    });
  });

  test("names all declared placeholders, not just the offending one", () => {
    expect(substituteCommand("bun test {{files}} {{grep}}", { nope: "x" })).toEqual({
      error: 'value "nope" is not a placeholder in this command (declared: files, grep)',
    });
  });

  test("a command with no placeholders reads naturally rather than printing an empty list", () => {
    expect(substituteCommand("bun test", { nope: "x" })).toEqual({
      error: 'value "nope" is not a placeholder in this command (this command declares no placeholders)',
    });
  });

  test("refuses a placeholder inside double quotes, where single-quote escaping is unsafe", () => {
    expect(substituteCommand('printf "%s\\n" "{{files}}"', { files: "$(printf PWNED)" })).toEqual({
      error: "placeholder {{files}} may not appear inside shell quotes",
    });
  });

  test("refuses a placeholder inside command substitution", () => {
    expect(substituteCommand("printf '%s\\n' $({{files}})", { files: "printf PWNED" })).toEqual({
      error: "placeholder {{files}} may not appear in a shell expansion",
    });
  });
});

// #1924: the model guessed a placeholder key 22 times across three runs (18 of
// them one session repeating the identical rejected call) because nothing --
// neither the error nor the tool description -- ever told it which
// placeholders a declared command actually has. The error-message half is
// covered above; this covers the description, which is what lets the model
// avoid the failed call altogether.
describe("createRunCommandTool description names each command's placeholders", () => {
  test("a command with a placeholder shows it inline", () => {
    const tool = createRunCommandTool(new Map([["testScoped", "bun test {{files}}"]]));
    expect(tool.description).toContain("testScoped ({{files}})");
  });

  test("a command with no placeholders reads naturally rather than printing empty parens", () => {
    const tool = createRunCommandTool(new Map([["test", "bun test"]]));
    expect(tool.description).toContain("test (no placeholders)");
  });

  test("multiple declared commands are each rendered with their own placeholders", () => {
    const tool = createRunCommandTool(
      new Map([
        ["test", "bun test"],
        ["testScoped", "bun test {{files}}"],
      ]),
    );
    expect(tool.description).toContain("test (no placeholders)");
    expect(tool.description).toContain("testScoped ({{files}})");
  });

  test("a command with several placeholders lists all of them", () => {
    const tool = createRunCommandTool(new Map([["lint", "bun lint {{files}} --grep {{grep}}"]]));
    expect(tool.description).toContain("lint ({{files}}, {{grep}})");
  });

  test("the non-exec description also renders placeholders, not bare keys", () => {
    const tool = createRunCommandTool(new Map([["testScoped", "bun test {{files}}"]]));
    expect(tool.description).not.toContain("declared commands: testScoped.");
    expect(tool.description).toContain("testScoped ({{files}})");
  });
});

// #1937 (first half): the argv branch's description advertised "only some
// commands and forms are permitted" without ever naming them. Across three
// runs the model guessed 32 times and was denied every time. The description
// must name the actual compiled grant -- which may be a project override, not
// the built-in list -- so the model can pick a legal form on the first try.
describe("createRunCommandTool description names the Exec allowlist", () => {
  function execTool(patterns: readonly string[]) {
    return createRunCommandTool(new Map([["test", "bun test"]]), {
      exec: {
        repoRoot: "/repo",
        packageWorkdir: "/repo",
        allowScripts: false,
        patterns,
      },
    });
  }

  test("no allowlist text appears when the Exec branch is not active", () => {
    const tool = createRunCommandTool(new Map([["test", "bun test"]]));
    expect(tool.description).not.toContain("permitted");
    expect(tool.description).not.toContain("argv");
  });

  test("names the built-in install patterns when that is the compiled grant", () => {
    const tool = execTool(["bun install", "bun add*", "npm ci"]);
    expect(tool.description).toContain("bun install, bun add*, npm ci");
  });

  test("names a project-overridden grant, not the built-in list", () => {
    const tool = execTool(["bun x tsc*"]);
    expect(tool.description).toContain("bun x tsc*");
    expect(tool.description).not.toContain("bun add*");
  });

  test('an unconditional "*" grant reads as any command permitted, not a literal asterisk', () => {
    const tool = execTool(["*"]);
    expect(tool.description).toMatch(/any command is permitted/i);
    expect(tool.description).not.toMatch(/permitted forms:.*\*/);
  });
});

test("a metacharacter in a value cannot run a second command", async () => {
  const tool = createRunCommandTool(new Map([["echoFiles", "echo {{files}}"]]));
  const result = await tool.run(
    { command: "echoFiles", values: { files: "a.ts; echo PWNED" } },
    { root: process.cwd(), resolvedPaths: [], maxBytes: 4096, maxFileBytes: 1024 },
  );
  expect(result.content).toContain("a.ts; echo PWNED");
  expect(result.content).not.toContain("\nPWNED");
  expect(result.content.match(/PWNED/g)?.length).toBe(1);
});

test("refuses a files path outside the repository root before running the command", async () => {
  const tool = createRunCommandTool(new Map([["echoFiles", "echo {{files}}"]]));
  const runtime = createCodingToolRuntime({
    policy: compileToolPolicy([{ tool: "RunCommand", patterns: ["*"] }], process.cwd()),
    extraTools: [tool],
  });

  const result = await runtime.callTool("RunCommand", {
    command: "echoFiles",
    values: { files: "/etc/passwd" },
  });

  expect(result.kind).toBe("denied");
  if (result.kind !== "denied") throw new Error("expected denial");
  expect(result.breach).toBe(true);
});

test("strips configured secrets from agent-invoked commands", async () => {
  const secretName = "NAX_C2_RUN_COMMAND_SECRET";
  const previous = process.env[secretName];
  process.env[secretName] = "must-not-reach-the-model";
  try {
    const tool = createRunCommandTool(new Map([["printEnv", `printf '%s' "$${secretName}"`]]), {
      stripEnvVars: [secretName],
    });
    const result = await tool.run(
      { command: "printEnv" },
      { root: process.cwd(), resolvedPaths: [], maxBytes: 4096, maxFileBytes: 1024 },
    );
    expect(result.content).not.toContain("must-not-reach-the-model");
  } finally {
    if (previous === undefined) delete process.env[secretName];
    else process.env[secretName] = previous;
  }
});

// #1936: `bun test .nax/features/foo/.nax-acceptance.test.ts` treats a bare
// dot-prefixed relative path as a FILTER, not a path, and reports a
// confident false "no tests matched" instead of running the file. The
// policy already resolves `values.files` (RunCommand's one path-bearing
// placeholder, per its `scope.pathFields`) to an absolute, approved path in
// `ctx.resolvedPaths` -- substituting that instead of the raw string is
// what every other tool in this directory already does.
describe("RunCommand substitutes the policy-resolved path (#1936)", () => {
  async function runFiles(root: string, files: string): Promise<string> {
    const runtime = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "RunCommand", patterns: ["*"] }], root),
      extraTools: [createRunCommandTool(new Map([["echoFiles", "echo {{files}}"]]))],
    });
    const result = await runtime.callTool("RunCommand", { command: "echoFiles", values: { files } });
    if (result.kind !== "ok") throw new Error(`expected ok, got ${result.kind}`);
    return result.content;
  }

  test("an existing file given as a dot-prefixed relative path is substituted absolute", async () => {
    await withTempDir(async (root) => {
      const relative = ".nax/features/demo/.nax-acceptance.test.ts";
      await mkdir(join(root, ".nax", "features", "demo"), { recursive: true });
      await writeFile(join(root, relative), "// acceptance\n");

      const content = await runFiles(root, relative);

      // realpath: macOS resolves /var -> /private/var, so compare against the
      // resolved root rather than the one mkdtemp handed back.
      expect(content).toContain(join(await realpath(root), relative));
      expect(content).not.toContain(`echo ${relative}`);
    });
  });

  test("a test-NAME filter is left alone, not absolutised into a path that matches nothing", async () => {
    // `{{files}}` is equally a name filter (`bun test run-command`), and
    // resolveWithin happily turns one into a nonexistent absolute path.
    // Absolutising it would silently break the cheapest move in a red/green
    // loop for every op that declares RunCommand.
    await withTempDir(async (root) => {
      const content = await runFiles(root, "run-command");
      expect(content).toContain("run-command");
      expect(content).not.toContain(await realpath(root));
    });
  });

  test("an empty values.files does not absolutise to the repository root", async () => {
    // resolveWithin(root, "") returns the ROOT, which would turn a no-op into
    // `bun test <root>` -- the entire suite, e2e included.
    await withTempDir(async (root) => {
      const content = await runFiles(root, "");
      expect(content).not.toContain(await realpath(root));
    });
  });

  test("a space-joined multi-file value is left alone rather than becoming one bogus path", async () => {
    // scoped-selection.ts builds `{{files}}` as several paths joined by a
    // space, so the plural shape is real. resolveWithin treats the whole
    // string as a single path, so length-based guards cannot catch it.
    await withTempDir(async (root) => {
      const content = await runFiles(root, "a.test.ts b.test.ts");
      expect(content).toContain("a.test.ts b.test.ts");
      expect(content).not.toContain(await realpath(root));
    });
  });

  test("behaviour is unchanged when the placeholder is not a path field", async () => {
    // "message" is not in RunCommand's scope.pathFields, so nothing resolves
    // for it -- this fix must not reach past the one placeholder it targets.
    await withTempDir(async (root) => {
      const runtime = createCodingToolRuntime({
        policy: compileToolPolicy([{ tool: "RunCommand", patterns: ["*"] }], root),
        extraTools: [createRunCommandTool(new Map([["echoMsg", "echo {{message}}"]]))],
      });
      const result = await runtime.callTool("RunCommand", {
        command: "echoMsg",
        values: { message: "./not-a-real-path.txt" },
      });
      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") throw new Error("expected ok");
      expect(result.content).toContain("./not-a-real-path.txt");
    });
  });
});
