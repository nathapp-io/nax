import { describe, expect, test } from "bun:test";
import { credentialsFor, EMPTY_NAX_CONFIG, loadNaxConfig, type ReadTextFile } from "#src/server/nax-config";

function reader(files: Readonly<Record<string, string>>): ReadTextFile {
  return async (path) => {
    const text = files[path];
    if (text === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    return text;
  };
}

const PATH = "/cfg/config.json";

describe("loadNaxConfig", () => {
  test("a missing file yields the defaults and no warning", async () => {
    expect(await loadNaxConfig("/cfg", reader({}))).toEqual({ config: EMPTY_NAX_CONFIG });
  });

  test("reads the native tiers in fast, balanced, powerful order, from both entry forms", async () => {
    const config = {
      models: {
        native: {
          powerful: "opencode-go/deepseek-v4.1-flash[high]",
          balanced: { provider: "minimax", model: "minimax/MiniMax-M3", contextWindow: 262144, pricing: { x: 1 } },
          fast: "minimax/MiniMax-M2.7",
          custom: "ignored/other",
        },
        claude: { fast: "claude-haiku" },
      },
    };
    const { config: loaded, warning } = await loadNaxConfig("/cfg", reader({ [PATH]: JSON.stringify(config) }));
    expect(warning).toBeUndefined();
    expect(loaded.tiers).toEqual([
      { tier: "fast", model: "minimax/MiniMax-M2.7" },
      { tier: "balanced", model: "minimax/MiniMax-M3", contextWindow: 262144 },
      { tier: "powerful", model: "opencode-go/deepseek-v4.1-flash[high]" },
    ]);
  });

  test("reads catalog overrides, auth and the agentServer block", async () => {
    const config = {
      agent: { native: { catalogOverrides: [{ provider: "minimax", models: [{ id: "m" }] }] } },
      auth: { source: "exec", exec: { command: ["pass", "show", "nax"] } },
      agentServer: { defaultMode: "full", bashApproval: "escalate", sessionsDir: "/s" },
    };
    const { config: loaded } = await loadNaxConfig("/cfg", reader({ [PATH]: JSON.stringify(config) }));
    expect(loaded.catalogOverrides).toEqual([{ provider: "minimax", models: [{ id: "m" }] }]);
    expect(loaded.auth).toEqual({
      source: "exec",
      exec: { command: ["pass", "show", "nax"], timeoutMs: 10000 },
      onChange: "warn",
    });
    expect(loaded.agentServer).toEqual({ defaultMode: "full", bashApproval: "escalate", sessionsDir: "/s" });
  });

  test("reads agentServer.mcpConnectTimeoutSeconds", async () => {
    const config = { agentServer: { mcpConnectTimeoutSeconds: 45 } };
    const { config: loaded } = await loadNaxConfig("/cfg", reader({ [PATH]: JSON.stringify(config) }));
    expect(loaded.agentServer).toEqual({ mcpConnectTimeoutSeconds: 45 });
  });

  test("an out-of-range connect timeout falls back to the defaults with a warning", async () => {
    const config = { agentServer: { mcpConnectTimeoutSeconds: 500 } };
    const loaded = await loadNaxConfig("/cfg", reader({ [PATH]: JSON.stringify(config) }));
    expect(loaded.config).toEqual(EMPTY_NAX_CONFIG);
    expect(loaded.warning).toContain("agentServer.mcpConnectTimeoutSeconds");
  });

  test("unrelated sections nax owns are ignored", async () => {
    const config = { review: { anything: true }, execution: 5, models: { native: { fast: "a/b" } } };
    const { config: loaded, warning } = await loadNaxConfig("/cfg", reader({ [PATH]: JSON.stringify(config) }));
    expect(warning).toBeUndefined();
    expect(loaded.tiers).toEqual([{ tier: "fast", model: "a/b" }]);
  });

  test("invalid JSON falls back to the defaults with a warning naming the file", async () => {
    const loaded = await loadNaxConfig("/cfg", reader({ [PATH]: "{ nope" }));
    expect(loaded.config).toEqual(EMPTY_NAX_CONFIG);
    expect(loaded.warning).toContain(PATH);
  });

  test("the invalid-JSON warning never echoes the file's content (review fix)", async () => {
    const loaded = await loadNaxConfig("/cfg", reader({ [PATH]: '{"headers": {"x": "sk-live-SECRET-123"' }));
    expect(loaded.warning).toContain("invalid JSON");
    expect(loaded.warning).not.toContain("SECRET");
  });

  test("an invalid section in the subset falls back to the defaults with a warning", async () => {
    const config = { agentServer: { defaultMode: "yolo" }, models: { native: { fast: "a/b" } } };
    const loaded = await loadNaxConfig("/cfg", reader({ [PATH]: JSON.stringify(config) }));
    expect(loaded.config).toEqual(EMPTY_NAX_CONFIG);
    expect(loaded.warning).toContain("agentServer.defaultMode");
  });

  test("auth source exec without exec is invalid, as in nax", async () => {
    const loaded = await loadNaxConfig("/cfg", reader({ [PATH]: JSON.stringify({ auth: { source: "exec" } }) }));
    expect(loaded.config).toEqual(EMPTY_NAX_CONFIG);
    expect(loaded.warning).toContain("exec");
  });

  test("a read error other than a missing file is a warning, not a crash", async () => {
    const failing: ReadTextFile = async () => {
      throw Object.assign(new Error("EACCES: denied"), { code: "EACCES" });
    };
    const loaded = await loadNaxConfig("/cfg", failing);
    expect(loaded.config).toEqual(EMPTY_NAX_CONFIG);
    expect(loaded.warning).toContain("EACCES");
  });
});

describe("credentialsFor", () => {
  test("points the credential store at the config dir and re-reads auth per call", async () => {
    const files: Record<string, string> = { [PATH]: JSON.stringify({ auth: { onChange: "refuse" } }) };
    const creds = credentialsFor("/cfg", reader(files));
    expect(creds.configDir()).toBe("/cfg");
    expect(await creds.readAuthConfig()).toEqual({ source: "file", onChange: "refuse" });
    files[PATH] = JSON.stringify({});
    expect(await creds.readAuthConfig()).toEqual({ source: "file", onChange: "warn" });
  });
});
