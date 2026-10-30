import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { AgentSessionError, type AgentSessionErrorCode } from "@nathapp/nax-agent";
import { _acpCatalogDeps, createAcpCatalog } from "@/chat/acp/acp-catalog";

type Kind = "local" | "npx" | undefined;
type ProbeKinds = Partial<Record<string, Kind>>;

const original = { ..._acpCatalogDeps };
const ENV = { PATH: "/test/bin" };
let probe: ReturnType<typeof mock<(agent: string, env?: Readonly<Record<string, string | undefined>>) => Kind>>;

function stubProbe(kinds: ProbeKinds = {}): void {
  probe = mock(
    (agent: string, _env?: Readonly<Record<string, string | undefined>>): Kind =>
      agent in kinds ? kinds[agent] : "local",
  );
  _acpCatalogDeps.launchCandidateKind = probe;
}

function catalog() {
  return createAcpCatalog({ env: ENV });
}

function sessionError(code: AgentSessionErrorCode, message = `injected ${code}`): AgentSessionError {
  return new AgentSessionError(message, code);
}

beforeEach(() => stubProbe());
afterEach(() => {
  _acpCatalogDeps.launchCandidateKind = original.launchCandidateKind;
});

describe("AcpCatalog.rows", () => {
  test("lists the three agents in order before anything is learned", () => {
    expect(catalog().rows()).toEqual(["acp:claude", "acp:codex", "acp:cursor"]);
  });

  test("lists an agent's learned models right after its row", () => {
    const acp = catalog();
    acp.opened("acp:codex", { offeredModels: ["gpt-5.5", "gpt-5.4"] });
    expect(acp.rows()).toEqual(["acp:claude", "acp:codex", "acp:codex/gpt-5.5", "acp:codex/gpt-5.4", "acp:cursor"]);
  });

  test("a non-empty report replaces the agent's rows, whichever model string reported it", () => {
    const acp = catalog();
    acp.opened("acp:codex/gpt-5.5", { offeredModels: ["gpt-5.5"] });
    acp.opened("acp:codex", { offeredModels: ["gpt-5.4"] });
    expect(acp.rows()).toContain("acp:codex/gpt-5.4");
    expect(acp.rows()).not.toContain("acp:codex/gpt-5.5");
  });

  test("keeps the previous models when a later report is not an array", () => {
    const acp = catalog();
    acp.opened("acp:codex", { offeredModels: ["gpt-5.5"] });
    acp.opened("acp:codex", { offeredModels: "gpt-5.4" });
    expect(acp.rows()).toContain("acp:codex/gpt-5.5");
    expect(acp.rows()).not.toContain("acp:codex/gpt-5.4");
  });

  test("keeps the previous models when a later report is empty", () => {
    const acp = catalog();
    acp.opened("acp:codex", { offeredModels: ["gpt-5.5"], offeredEfforts: ["high"] });
    acp.opened("acp:codex", { offeredModels: [], offeredEfforts: [] });
    expect(acp.rows()).toContain("acp:codex/gpt-5.5");
  });

  test("keeps the previous models when a later report carries no fields", () => {
    const acp = catalog();
    acp.opened("acp:codex", { offeredModels: ["gpt-5.5"] });
    acp.opened("acp:codex", {});
    expect(acp.rows()).toContain("acp:codex/gpt-5.5");
  });

  test("learns only the string elements of a report", () => {
    const acp = catalog();
    acp.opened("acp:codex", { offeredModels: ["gpt-5.5", 7] });
    expect(acp.rows()).toEqual(["acp:claude", "acp:codex", "acp:codex/gpt-5.5", "acp:cursor"]);
  });

  test("keeps each agent's models apart", () => {
    const acp = catalog();
    acp.opened("acp:codex", { offeredModels: ["gpt-5.5"] });
    acp.opened("acp:claude", { offeredModels: ["opus"] });
    expect(acp.rows()).toEqual(["acp:claude", "acp:claude/opus", "acp:codex", "acp:codex/gpt-5.5", "acp:cursor"]);
  });

  test("ignores an open of a native model", () => {
    const acp = catalog();
    acp.opened("openai/gpt-6", { offeredModels: ["x"] });
    expect(acp.rows()).toEqual(["acp:claude", "acp:codex", "acp:cursor"]);
  });
});

describe("AcpCatalog.effortLevels", () => {
  test("is only default before any open", () => {
    expect(catalog().effortLevels("acp:codex")).toEqual(["default"]);
  });

  test("keeps the previous efforts when a later report is empty", () => {
    const acp = catalog();
    acp.opened("acp:codex", { offeredModels: ["gpt-5.5"], offeredEfforts: ["high"] });
    acp.opened("acp:codex", { offeredModels: [], offeredEfforts: [] });
    expect(acp.effortLevels("acp:codex")).toEqual(["default", "high"]);
  });

  test("applies the agent's levels to a model string carrying an effort", () => {
    const acp = catalog();
    acp.opened("acp:codex", { offeredEfforts: ["low", "high"] });
    expect(acp.effortLevels("acp:codex/gpt-5.5[high]")).toEqual(["default", "low", "high"]);
  });

  test("does not lend one agent's levels to another", () => {
    const acp = catalog();
    acp.opened("acp:codex", { offeredEfforts: ["low", "high"] });
    expect(acp.effortLevels("acp:claude")).toEqual(["default"]);
  });
});

describe("AcpCatalog install probe", () => {
  test("reports an agent whose binary does not resolve as not installed", () => {
    stubProbe({ cursor: undefined });
    const acp = catalog();
    expect(acp.installed("acp:cursor")).toBe(false);
    expect(acp.unavailable("acp:cursor")).toBe("not installed");
  });

  test("counts an npx-only agent as installed", () => {
    stubProbe({ claude: "npx" });
    const acp = catalog();
    expect(acp.installed("acp:claude")).toBe(true);
    expect(acp.unavailable("acp:claude")).toBeUndefined();
  });

  test("probes each agent once with the supplied env across repeated calls", () => {
    const acp = catalog();
    acp.rows();
    acp.rows();
    acp.installed("acp:codex");
    acp.unavailable("acp:codex");
    acp.installed("acp:claude");
    expect(probe).toHaveBeenCalledTimes(3);
    expect(probe.mock.calls.map(([agent]) => agent).sort()).toEqual(["claude", "codex", "cursor"]);
    for (const [, env] of probe.mock.calls) expect(env).toBe(ENV);
  });
});

describe("AcpCatalog.failed", () => {
  test("records an auth failure as not logged in, for every model of the agent", () => {
    const acp = catalog();
    acp.failed("acp:codex", sessionError("AGENT_SESSION_AUTH_REQUIRED"));
    expect(acp.unavailable("acp:codex/gpt-5.5")).toBe("not logged in");
    expect(acp.unavailable("acp:claude")).toBeUndefined();
  });

  test("records the first line of an unavailable backend's message", () => {
    const acp = catalog();
    acp.failed("acp:codex", sessionError("AGENT_SESSION_BACKEND_UNAVAILABLE", "spawn failed\nmore"));
    expect(acp.unavailable("acp:codex")).toBe("spawn failed");
  });

  test("caps the recorded reason at 120 characters", () => {
    const acp = catalog();
    const line = "x".repeat(200);
    acp.failed("acp:codex", sessionError("AGENT_SESSION_BACKEND_UNAVAILABLE", `${line}\nmore`));
    expect(acp.unavailable("acp:codex")).toBe("x".repeat(120));
  });

  test("records nothing for a model mismatch", () => {
    const acp = catalog();
    acp.failed("acp:codex", sessionError("AGENT_SESSION_MODEL_MISMATCH"));
    expect(acp.unavailable("acp:codex")).toBeUndefined();
  });

  test("records nothing for an unsupported capability, a timeout or a non-error", () => {
    const acp = catalog();
    acp.failed("acp:codex", sessionError("AGENT_SESSION_CAPABILITY_UNSUPPORTED"));
    acp.failed("acp:codex", new Error("timed out"));
    acp.failed("acp:codex", "boom");
    expect(acp.unavailable("acp:codex")).toBeUndefined();
  });

  test("ignores a failure of a native model", () => {
    const acp = catalog();
    acp.failed("openai/gpt-6", sessionError("AGENT_SESSION_AUTH_REQUIRED"));
    expect(acp.unavailable("openai/gpt-6")).toBeUndefined();
  });

  test("a later successful open clears the recorded failure", () => {
    const acp = catalog();
    acp.failed("acp:codex", sessionError("AGENT_SESSION_AUTH_REQUIRED"));
    acp.opened("acp:codex", {});
    expect(acp.unavailable("acp:codex")).toBeUndefined();
  });

  test("not installed outranks a recorded failure", () => {
    stubProbe({ codex: undefined });
    const acp = catalog();
    acp.failed("acp:codex", sessionError("AGENT_SESSION_AUTH_REQUIRED"));
    expect(acp.unavailable("acp:codex")).toBe("not installed");
  });
});

describe("AcpCatalog with a native model", () => {
  test("has no unavailable reason and counts as installed", () => {
    const acp = catalog();
    expect(acp.unavailable("openai/gpt-6")).toBeUndefined();
    expect(acp.installed("openai/gpt-6")).toBe(true);
  });
});
