import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  cleanupTempDir,
  makeContextBundle,
  makeMockAgentManager,
  makeNaxConfig,
  makeSessionManager,
  makeStory,
  makeTempDir,
} from "@test/helpers";
import { resolveDispatchAuditDir } from "@/agents/coding-tool-support-resolve";
import type { AgentRunOptions, SessionHandle, TurnResult } from "@/agents/types";
import { _buildHopCallbackDeps, buildHopCallback } from "@/operations";
import type { BuildHopCallbackContext } from "@/operations/build-hop-callback";
import type { OpenSessionRequest } from "@/session/types";

const TURN: TurnResult = {
  output: "done",
  tokenUsage: { inputTokens: 1, outputTokens: 1 },
  estimatedCostUsd: 0,
  internalRoundTrips: 1,
};

let origCreateContextToolRuntime: typeof _buildHopCallbackDeps.createContextToolRuntime;
let root = "";

beforeEach(() => {
  origCreateContextToolRuntime = _buildHopCallbackDeps.createContextToolRuntime;
  _buildHopCallbackDeps.createContextToolRuntime = () => undefined;
  root = makeTempDir("nax-hop-audit-");
});

afterEach(() => {
  _buildHopCallbackDeps.createContextToolRuntime = origCreateContextToolRuntime;
  cleanupTempDir(root);
});

async function openRequestFor(extra: Partial<AgentRunOptions>): Promise<OpenSessionRequest | undefined> {
  const requests: OpenSessionRequest[] = [];
  const config = makeNaxConfig();
  const ctx: BuildHopCallbackContext = {
    sessionManager: makeSessionManager({
      openSession: mock(async (name: string, opts: OpenSessionRequest) => {
        requests.push(opts);
        return { id: name, agentName: opts.agentName } satisfies SessionHandle;
      }),
      closeSession: mock(async () => {}),
    }),
    agentManager: makeMockAgentManager({ runAsSessionFn: mock(async () => TURN) }),
    story: makeStory({ id: "US-001" }),
    config,
    featureName: "feat",
    workdir: root,
    effectiveTier: "balanced",
    defaultAgent: "claude",
    pipelineStage: "run",
  };
  const options: AgentRunOptions = {
    prompt: "p",
    workdir: root,
    modelTier: "balanced",
    modelDef: { provider: "anthropic", model: "sonnet" },
    timeoutSeconds: 30,
    config,
    storyId: "US-001",
    sessionRole: "implementer",
    featureName: "feat",
    runId: "run-7",
    ...extra,
  };
  await buildHopCallback(ctx, undefined, options)("claude", makeContextBundle(), { kind: "primary" }, options);
  return requests[0];
}

describe("prepareHopSession: toolAudit (S4b spec §7.4)", () => {
  test("carries the ledger dir and header native resolves when a coding-tool root is set", async () => {
    const request = await openRequestFor({ codingToolRoot: root, outputDir: root });
    const dir = resolveDispatchAuditDir(root, root, "feat");
    expect(dir).toBeDefined();
    expect(request?.toolAudit).toEqual({
      dir: dir as string,
      header: { runId: "run-7", featureName: "feat", storyId: "US-001", sessionRole: "implementer" },
    });
  });

  test("no coding-tool root: no toolAudit key", async () => {
    const request = await openRequestFor({});
    expect(request).toBeDefined();
    expect(request).not.toHaveProperty("toolAudit");
  });
});
