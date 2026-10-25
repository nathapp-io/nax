import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { _clearRootConfigCache, loadConfig } from "@/config/loader";

describe("loadConfig — mcp.servers headers stay literal (US-002)", () => {
  let dir: string;
  let globalDir: string;
  let prevGlobal: string | undefined;
  let prevVar: string | undefined;

  beforeEach(() => {
    dir = realpathSync(makeTempDir("nax-mcp-literal-"));
    globalDir = join(dir, ".global-nax");
    mkdirSync(join(dir, ".nax"), { recursive: true });
    mkdirSync(globalDir, { recursive: true });
    prevGlobal = process.env.NAX_GLOBAL_CONFIG_DIR;
    prevVar = process.env.NAX_MCP_LITERAL_PROBE;
    process.env.NAX_GLOBAL_CONFIG_DIR = globalDir;
    process.env.NAX_MCP_LITERAL_PROBE = "expanded";
    _clearRootConfigCache();
  });

  afterEach(() => {
    if (prevGlobal === undefined) delete process.env.NAX_GLOBAL_CONFIG_DIR;
    else process.env.NAX_GLOBAL_CONFIG_DIR = prevGlobal;
    if (prevVar === undefined) delete process.env.NAX_MCP_LITERAL_PROBE;
    else process.env.NAX_MCP_LITERAL_PROBE = prevVar;
    cleanupTempDir(dir);
  });

  const reference = "$" + "{NAX_MCP_LITERAL_PROBE}";
  const server = { url: "https://h/mcp", headers: { X: reference }, stages: ["*"] };

  test("project config keeps the reference literal", async () => {
    writeFileSync(join(dir, ".nax", "config.json"), JSON.stringify({ name: "p", mcp: { servers: { a: server } } }));
    const config = await loadConfig(dir);
    expect(config.mcp?.servers.a?.headers?.X).toBe(reference);
  });

  test("global config keeps the reference literal", async () => {
    writeFileSync(join(globalDir, "config.json"), JSON.stringify({ mcp: { servers: { a: server } } }));
    writeFileSync(join(dir, ".nax", "config.json"), JSON.stringify({ name: "p" }));
    const config = await loadConfig(dir);
    expect(config.mcp?.servers.a?.headers?.X).toBe(reference);
  });
});
