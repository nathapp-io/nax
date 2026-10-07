import { describe, expect, test } from "bun:test";
import { checkAcpBundling, checkAgentBundling } from "@scripts/lib/agent-bundling";

const NAX = {
  scripts: { build: 'bun build bin/nax.ts --external "@nathapp/nax-ai"' },
  dependencies: { "@nathapp/nax-ai": "0.1.16", zod: "^4.3.6" },
  devDependencies: { "@nathapp/nax-agent": "workspace:*" },
};
const AGENT = { dependencies: { "@nathapp/nax-ai": "0.1.16", zod: "^4.3.6" } };

describe("checkAgentBundling", () => {
  test("the bundled layout passes", () => {
    expect(checkAgentBundling(NAX, AGENT)).toEqual([]);
  });

  test("a workspace: spec in nax's dependencies fails, since npm cannot install it", () => {
    const nax = { ...NAX, dependencies: { ...NAX.dependencies, "@nathapp/nax-agent": "workspace:*" } };
    expect(checkAgentBundling(nax, AGENT)).toEqual([
      "nax dependency @nathapp/nax-agent uses workspace:*; npm cannot install it",
    ]);
  });

  test("nax-agent must be a workspace devDependency and stay out of --external", () => {
    const nax = { ...NAX, scripts: { build: '--external "@nathapp/nax-agent"' }, devDependencies: {} };
    expect(checkAgentBundling(nax, AGENT)).toHaveLength(2);
  });

  test("every runtime dependency of nax-agent is declared by nax at the same version", () => {
    const agent = { dependencies: { ...AGENT.dependencies, zod: "^4.4.0", chalk: "^5" } };
    expect(checkAgentBundling(NAX, agent)).toEqual([
      "nax-agent depends on zod@^4.4.0; nax must declare the same in dependencies (found ^4.3.6)",
      "nax-agent depends on chalk@^5; nax must declare the same in dependencies (found undefined)",
    ]);
  });
});

describe("checkAcpBundling", () => {
  const ACP = {
    dependencies: { "@agentclientprotocol/sdk": "~1.7.0", "@modelcontextprotocol/sdk": "^1.30.0", zod: "^4.3.6" },
  };
  const NAX_WITH_ACP = {
    ...NAX,
    dependencies: { ...NAX.dependencies, "@agentclientprotocol/sdk": "~1.7.0", "@modelcontextprotocol/sdk": "^1.30.0" },
    devDependencies: { ...NAX.devDependencies, "@nathapp/nax-agent-acp": "workspace:*" },
  };

  test("the bundled layout passes", () => {
    expect(checkAcpBundling(NAX_WITH_ACP, ACP)).toEqual([]);
  });

  test("nax-agent-acp must be a workspace devDependency and stay out of --external", () => {
    const nax = {
      ...NAX_WITH_ACP,
      scripts: { build: '--external "@nathapp/nax-agent-acp"' },
      devDependencies: NAX.devDependencies,
    };
    expect(checkAcpBundling(nax, ACP)).toEqual([
      'nax must list @nathapp/nax-agent-acp as a devDependency "workspace:*" (it is bundled, not installed)',
      "the build script must bundle @nathapp/nax-agent-acp, not mark it --external",
    ]);
  });

  test("every runtime dependency of nax-agent-acp is declared by nax at the same version", () => {
    const nax = { ...NAX_WITH_ACP, dependencies: NAX.dependencies };
    expect(checkAcpBundling(nax, ACP)).toEqual([
      "nax-agent-acp depends on @agentclientprotocol/sdk@~1.7.0; nax must declare the same in dependencies (found undefined)",
      "nax-agent-acp depends on @modelcontextprotocol/sdk@^1.30.0; nax must declare the same in dependencies (found undefined)",
    ]);
  });
});
