import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { runMcpLockCommand } from "@/cli/mcp";
import { _mcpClientDeps } from "@/mcp/client";
import { schemaHash } from "@/mcp/lock";

const original = { ..._mcpClientDeps };
let projectDir: string;

beforeEach(() => {
  projectDir = realpathSync(makeTempDir("nax-cli-mcp-"));
  mkdirSync(join(projectDir, ".nax"), { recursive: true });
});

afterEach(() => {
  Object.assign(_mcpClientDeps, original);
  cleanupTempDir(projectDir);
});

function httpConn(tools: { name: string; description: string; inputSchema: Record<string, unknown> }[]) {
  return {
    kind: "http" as const,
    pid: null,
    tools,
    call: async () => ({ text: "", isError: false, bytesBeforeCap: 0 }),
    onClose: () => {},
    close: async () => {},
  };
}

function writeConfig(servers: Record<string, unknown>): void {
  writeFileSync(join(projectDir, ".nax", "config.json"), JSON.stringify({ name: "probe", mcp: { servers } }));
}

async function lockOutput(): Promise<string> {
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    await runMcpLockCommand(projectDir);
    return log.mock.calls.map((call) => call.join(" ")).join("\n");
  } finally {
    log.mockRestore();
  }
}

describe("runMcpLockCommand empty-server hint", () => {
  test("AC-19: an HTTP server that advertises no tools is named by its url", async () => {
    Object.assign(_mcpClientDeps, { connect: async () => httpConn([]) });
    writeConfig({ docs: { url: "https://docs.example/mcp", stages: ["*"] } });

    const output = await lockOutput();

    expect(output).toContain("https://docs.example/mcp");
    expect(output).not.toContain("undefined");
  });

  test("F5: a credential-bearing url is redacted in the hint on an empty server", async () => {
    Object.assign(_mcpClientDeps, { connect: async () => httpConn([]) });
    writeConfig({ docs: { url: "https://u:pw9@docs.example/mcp?key=s3cret#frag", stages: ["*"] } });

    const output = await lockOutput();

    expect(output).toContain("docs.example/mcp");
    expect(output).not.toMatch(/pw9|s3cret|frag/);
  });

  test("F5: a credential-bearing url is redacted in the hint when the connection fails", async () => {
    Object.assign(_mcpClientDeps, {
      connect: async () => {
        throw new Error("down");
      },
    });
    writeConfig({ docs: { url: "https://u:pw9@docs.example/mcp?key=s3cret", stages: ["*"] } });

    const output = await lockOutput();

    expect(output).toContain("docs.example/mcp");
    expect(output).not.toMatch(/pw9|s3cret/);
  });
});

describe("runMcpLockCommand keeps readOnly grants (F1)", () => {
  const schema = { type: "object" };
  const advertise = (names: string[]) =>
    Object.assign(_mcpClientDeps, {
      connect: async () => httpConn(names.map((name) => ({ name, description: "d", inputSchema: schema }))),
    });
  const previousLock = {
    version: 1,
    servers: { docs: { get: schemaHash(schema), put: "stale" } },
    readOnly: { docs: ["get", "put"] },
  };

  async function readLock(path: string): Promise<{ readOnly?: Record<string, string[]> }> {
    return JSON.parse(await Bun.file(path).text());
  }

  test("project refresh preserves the grant of a tool whose schema hash is unchanged", async () => {
    advertise(["get", "put"]);
    writeConfig({ docs: { url: "https://docs.example/mcp", stages: ["*"] } });
    const path = join(projectDir, ".nax", "mcp-lock.json");
    writeFileSync(path, JSON.stringify(previousLock));

    await lockOutput();

    expect((await readLock(path)).readOnly).toEqual({ docs: ["get"] });
  });

  test("global refresh preserves the grant of a tool whose schema hash is unchanged", async () => {
    advertise(["get", "put"]);
    writeConfig({ docs: { url: "https://docs.example/mcp", stages: ["*"] } });
    const globalDir = join(projectDir, ".global");
    mkdirSync(globalDir, { recursive: true });
    const previous = process.env.NAX_GLOBAL_CONFIG_DIR;
    process.env.NAX_GLOBAL_CONFIG_DIR = globalDir;
    try {
      const path = join(globalDir, "mcp-lock.json");
      writeFileSync(path, JSON.stringify(previousLock));
      const log = spyOn(console, "log").mockImplementation(() => {});
      try {
        await runMcpLockCommand(projectDir, { global: true });
      } finally {
        log.mockRestore();
      }
      expect((await readLock(path)).readOnly).toEqual({ docs: ["get"] });
    } finally {
      if (previous === undefined) delete process.env.NAX_GLOBAL_CONFIG_DIR;
      else process.env.NAX_GLOBAL_CONFIG_DIR = previous;
    }
  });
});
