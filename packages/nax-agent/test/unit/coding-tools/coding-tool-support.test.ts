/**
 * `buildCodingToolSupport` carries the rendered `## MCP servers` section
 * (#2517) untouched: the resolver renders it (nax's
 * `resolveCodingToolSupport`), and the session open reads it back off the
 * support. This module only passes it through.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { buildCodingToolSupport } from "#src/coding-tools/coding-tool-support";
import { cleanupTempDir, makeTempDir } from "#test/helpers/index";

let root: string;
beforeEach(() => {
  root = realpathSync(makeTempDir("coding-tool-support-"));
  mkdirSync(join(root, ".git"), { recursive: true });
});
afterEach(() => cleanupTempDir(root));

/** The minimum that builds a session: one declared tool, granted. */
const support = (extra: { providerInstructions?: string } = {}) =>
  buildCodingToolSupport({ root, declared: ["Read"], grants: [{ tool: "Read", patterns: ["*"] }], ...extra });

describe("buildCodingToolSupport — providerInstructions", () => {
  test("carries the rendered section onto the support", () => {
    expect(support({ providerInstructions: "X" })?.providerInstructions).toBe("X");
  });

  test("a support built without one has no providerInstructions key", () => {
    expect("providerInstructions" in (support() ?? {})).toBe(false);
  });
});
