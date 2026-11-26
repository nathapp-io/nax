/**
 * US-020 — the chat-only lock on the web factories.
 *
 * The web tools are only useful (and only safe) inside `nax chat`: the provider records what the
 * session read and the guard swaps the process-wide sandbox network once it has. A run, story,
 * bot or workflow session that constructed the same provider would have no footer, no guard port
 * and, in the case of `nax run`, no exposure state at all — so the factories are fenced to the one
 * file that wires a chat session. Each fixture below is the shape that fence has to catch.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  ALLOWED_WEB_FILE,
  findWebChatOnlyViolations,
  runWebChatOnlyGate,
  WEB_FACTORY_NAMES,
} from "@scripts/check-web-chat-only";
import { cleanupTempDir, makeTempDir } from "@test/helpers";

/** The nax package root: `test/unit/scripts` -> `packages/nax`. */
const PACKAGE_ROOT = join(import.meta.dir, "..", "..", "..");

let root: string;

beforeEach(() => {
  root = makeTempDir("nax-web-chat-only-");
});

afterEach(() => cleanupTempDir(root));

/** Write one fixture file, creating its directory chain. */
function writeFixture(relativePath: string, body: string): void {
  const full = join(root, relativePath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body, "utf8");
}

describe("check-web-chat-only", () => {
  test("AC-1: the wiring file may import a web factory", () => {
    writeFixture(
      ALLOWED_WEB_FILE,
      'import { createWebToolProvider } from "@nathapp/nax-agent/internal";\n\nexport const p = createWebToolProvider;\n',
    );

    const result = runWebChatOnlyGate(root);

    expect(result.exitCode).toBe(0);
    expect(findWebChatOnlyViolations(root)).toEqual([]);
  });

  test("AC-2: a workflow module importing a web factory fails and is named", () => {
    writeFixture(
      "src/workflow/x.ts",
      'import { createWebToolProvider } from "@nathapp/nax-agent/internal";\n\nexport const p = createWebToolProvider;\n',
    );

    const result = runWebChatOnlyGate(root);

    expect(result.exitCode).toBe(1);
    expect(result.report).toContain("src/workflow/x.ts");
    expect(findWebChatOnlyViolations(root)).toMatchObject([
      { file: "src/workflow/x.ts", line: 1, names: ["createWebToolProvider"] },
    ]);
  });

  test("AC-3: a chat subagent module importing the guard fails and is named", () => {
    writeFixture(
      "src/chat/subagent-runs.ts",
      'import { createWebExposureGuard } from "@nathapp/nax-agent/internal";\n\nexport const g = createWebExposureGuard;\n',
    );

    const result = runWebChatOnlyGate(root);

    expect(result.exitCode).toBe(1);
    expect(result.report).toContain("src/chat/subagent-runs.ts");
    expect(findWebChatOnlyViolations(root)).toMatchObject([
      { file: "src/chat/subagent-runs.ts", line: 1, names: ["createWebExposureGuard"] },
    ]);
  });

  test("AC-4: a factory in a multi-line import list is caught", () => {
    writeFixture(
      "src/runtime/x.ts",
      [
        "import {",
        "  BASH_TOOL_NAME,",
        "  createWebExposure,",
        "  type CommandLauncher,",
        '} from "@nathapp/nax-agent/internal";',
        "",
        "export const e = createWebExposure;",
        "",
      ].join("\n"),
    );

    const result = runWebChatOnlyGate(root);

    expect(result.exitCode).toBe(1);
    expect(result.report).toContain("src/runtime/x.ts");
    expect(findWebChatOnlyViolations(root)).toMatchObject([
      { file: "src/runtime/x.ts", line: 1, names: ["createWebExposure"] },
    ]);
  });

  test("AC-5: a factory named only in a comment is not a violation", () => {
    writeFixture(
      "src/workflow/x.ts",
      [
        "/**",
        " * This module deliberately never calls createWebToolProvider: a run session has",
        " * no exposure state and no guard port (US-020).",
        " */",
        "// createWebToolProvider would be wrong here too",
        "export const x = 1; /* createWebToolProvider */",
        "",
      ].join("\n"),
    );

    const result = runWebChatOnlyGate(root);

    expect(result.exitCode).toBe(0);
    expect(findWebChatOnlyViolations(root)).toEqual([]);
  });

  test("AC-6: the real packages/nax tree satisfies the gate", () => {
    const result = runWebChatOnlyGate(PACKAGE_ROOT);

    expect(findWebChatOnlyViolations(PACKAGE_ROOT)).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  test("an aliased named import is caught", () => {
    writeFixture(
      "src/bot/x.ts",
      'import { createWebToolProvider as provider } from "@nathapp/nax-agent/internal";\n\nexport const p = provider;\n',
    );

    expect(findWebChatOnlyViolations(root).map((v) => v.file)).toEqual(["src/bot/x.ts"]);
  });

  test("a re-export from the internal entry is caught", () => {
    writeFixture("src/bot/x.ts", 'export { createSearchBackend } from "@nathapp/nax-agent/internal";\n');

    expect(findWebChatOnlyViolations(root).map((v) => v.names)).toEqual([["createSearchBackend"]]);
  });

  test("a name imported from somewhere other than the internal entry is not a violation", () => {
    writeFixture("src/bot/x.ts", 'import { createWebToolProvider } from "./local-web";\n');

    expect(findWebChatOnlyViolations(root)).toEqual([]);
  });

  test("a quote inside a regex literal does not hide the import below it", () => {
    writeFixture(
      "src/bot/x.ts",
      [
        "const QUOTES = /[\"']/g;",
        `const TEMPLATE = \`a \${"b"} c\`;`,
        "",
        'import { createWebExposure } from "@nathapp/nax-agent/internal";',
        "",
        "export const e = createWebExposure;",
        "export { QUOTES, TEMPLATE };",
        "",
      ].join("\n"),
    );

    expect(findWebChatOnlyViolations(root).map((v) => v.names)).toEqual([["createWebExposure"]]);
  });

  test("a root without src/ fails rather than silently passing", () => {
    const result = runWebChatOnlyGate(root);

    expect(result.exitCode).toBe(1);
    expect(result.report).toContain("src");
  });

  test("the CLI exits 1 and prints the file for a fixture root given as argv", async () => {
    writeFixture(
      "src/workflow/x.ts",
      'import { createWebToolProvider } from "@nathapp/nax-agent/internal";\n\nexport const p = createWebToolProvider;\n',
    );

    const proc = Bun.spawn(["bun", join(PACKAGE_ROOT, "scripts", "check-web-chat-only.ts"), root], {
      cwd: PACKAGE_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("src/workflow/x.ts");
  });

  test("the four factory names are exactly the fenced set", () => {
    expect([...WEB_FACTORY_NAMES].sort()).toEqual([
      "createSearchBackend",
      "createWebExposure",
      "createWebExposureGuard",
      "createWebToolProvider",
    ]);
  });
});
