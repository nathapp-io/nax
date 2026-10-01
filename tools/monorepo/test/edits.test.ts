// tools/monorepo/test/edits.test.ts
import { describe, expect, test } from "bun:test";
import { editClaudeSettings, editContributing, editNaxPackageJson, markBiomeNested, splitNaxConfig } from "../lib/edits";

describe("edits", () => {
  test("editNaxPackageJson adds repository.directory and keeps key order", () => {
    const out = JSON.parse(editNaxPackageJson(JSON.stringify({ name: "@nathapp/nax", repository: { type: "git", url: "u" }, scripts: {} }, null, 2)));
    expect(out.repository).toEqual({ type: "git", url: "u", directory: "packages/nax" });
    expect(Object.keys(out)).toEqual(["name", "repository", "scripts"]);
  });
  test("editNaxPackageJson refuses a prepare script", () => {
    expect(() => editNaxPackageJson(JSON.stringify({ scripts: { prepare: "x" }, repository: {} }))).toThrow(/prepare/);
  });
  test("splitNaxConfig moves quality.commands to mono and puts root scripts at root", () => {
    const cfg = { name: "nax", quality: { commands: { test: "bun run test", typecheck: ["a", "b"] }, forceExit: false }, review: { enabled: true } };
    const { root, mono } = splitNaxConfig(JSON.stringify(cfg, null, 2));
    expect(JSON.parse(mono)).toEqual({ quality: { commands: { test: "bun run test", typecheck: ["a", "b"] } } });
    const r = JSON.parse(root);
    expect(r.quality.commands).toEqual({ test: "bun run test", typecheck: "bun run typecheck", lint: "bun run check:all", build: "bun run build" });
    expect(r.quality.forceExit).toBe(false);
    expect(r.review).toEqual({ enabled: true });
    expect(r.name).toBe("nax");
  });
  test("editClaudeSettings rewrites the biome hook to run inside the package", () => {
    const s = JSON.stringify({ hooks: { PostToolUse: [{ matcher: "Edit|Write", hooks: [{ type: "command", command: "bun x biome lint --write src/ bin/" }] }] } });
    expect(JSON.parse(editClaudeSettings(s)).hooks.PostToolUse[0].hooks[0].command).toBe("cd packages/nax && bun x biome lint --write src/ bin/");
  });
  test("editContributing adds the package note once and fixes the bare bun test line", () => {
    const src = "## Development Setup\n\n```bash\nbun install\n```\n\n3. Ensure the full test suite passes: `bun test`\n";
    const out = editContributing(src);
    expect(out).toContain("Package commands below run from `packages/nax/`");
    expect(out).toContain("`bun run test`");
    expect(editContributing(out)).toBe(out);
  });
  test("markBiomeNested puts root:false first", () => {
    expect(Object.keys(JSON.parse(markBiomeNested('{"$schema":"s","linter":{}}')))).toEqual(["root", "$schema", "linter"]);
  });
});
