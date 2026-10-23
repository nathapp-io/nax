import { afterEach, describe, expect, mock, test } from "bun:test";
import { resolveProviderTools, type ToolProvider } from "@nathapp/nax-agent";
import {
  assertDefined,
  cleanupTempDir,
  makeBotFixEnv,
  makeFeatureContext,
  makeScriptedCallOp,
  makeTempDir,
} from "@test/helpers";
import { _forgeToolsDeps } from "@/forge-tools";
import { _featureDeps } from "@/workflow/feature-deps";
import { buildFeatureEnv } from "@/workflow/feature-env";
import { newFeatureRecord } from "@/workflow/feature-record";
import { _workflowDeps } from "@/workflow/step-context";
import { startTokenMeter } from "@/workflow/tokens";

const original = { ..._workflowDeps };
const forgeOriginal = { ..._forgeToolsDeps };
const featureOriginal = { ..._featureDeps };
const dirs: string[] = [];
afterEach(async () => {
  Object.assign(_workflowDeps, original);
  Object.assign(_forgeToolsDeps, forgeOriginal);
  Object.assign(_featureDeps, featureOriginal);
  await Promise.all(dirs.splice(0).map(cleanupTempDir));
});

function setup() {
  const dir = makeTempDir("forge-binding-");
  dirs.push(dir);
  const fc = makeFeatureContext({ runDir: dir, projectDir: dir, outputDir: dir, reportPath: `${dir}/report.md` });
  _workflowDeps.git = async () => ({ stdout: "", exitCode: 0 });
  const contexts: (typeof fc.callCtx)[] = [];
  _workflowDeps.callOp = makeScriptedCallOp((_op, _input, ctx) => {
    contexts.push(ctx);
    return { status: "DONE", commits: [], testSummary: "", interrupted: false };
  });
  const env = buildFeatureEnv(
    fc,
    {
      runtime: fc.callCtx.runtime,
      config: fc.config,
      prd: fc.prd,
      feature: fc.feature,
      workdir: fc.projectDir,
      branch: fc.branch,
      runId: fc.runId,
      agentName: "native",
    },
    {
      stories: [],
      ledgerItems: { deferredMinors: [], cannotVerify: [], parked: [] },
      record: newFeatureRecord({ now: "t", seed: "s", minors: [] }),
      meter: startTokenMeter(undefined),
      preflight: null,
      specPath: "",
    },
  );
  return { fc, env, contexts };
}

async function prTool(providers: readonly ToolProvider[] | undefined) {
  expect(providers).toHaveLength(1);
  expect(providers?.[0]?.id).toBe("nax-forge");
  const resolved = await resolveProviderTools(providers ?? [], "run", "/unrelated");
  const pr = resolved.tools.find((tool) => tool.name === "nax-forge__pr");
  assertDefined(pr);
  return pr.run({}, { root: "/unrelated", resolvedPaths: [], maxBytes: 2_000, maxFileBytes: 2_000 });
}

describe("workflow repair forge bindings", () => {
  test("AC-3/4 attaches one provider and resolves the published PR using feature forge deps and cwd", async () => {
    const { fc, env, contexts } = setup();
    const ref = { forge: "github", host: "github.com", repo: "o/r", number: 7 } as const;
    const forge = { run: mock(async () => ({ exitCode: 0, stdout: "", stderr: "" })), readText: async () => null };
    _featureDeps.forge = forge;
    const resolve = mock(async () => ref);
    _forgeToolsDeps.resolvePrRef = resolve;
    _forgeToolsDeps.readPrInfo = mock(async () => makeBotFixEnv().info);
    await env.steps.branchFix([], { prUrl: "https://github.com/o/r/pull/7" });
    expect(contexts).toHaveLength(1);
    await prTool(contexts[0]?.toolProviders);
    expect(resolve).toHaveBeenCalledWith(7, forge, fc.projectDir);
    expect(_forgeToolsDeps.readPrInfo).toHaveBeenCalledWith(ref, forge, fc.projectDir);
  });

  test("AC-5 no-options branch fix has no provider in call context", async () => {
    const { env, contexts } = setup();
    await env.steps.branchFix([]);
    expect(contexts).toHaveLength(1);
    expect(contexts[0]).not.toHaveProperty("toolProviders");
  });

  test("AC-9 malformed bound URL returns an error naming the URL instead of rejecting", async () => {
    const { env, contexts } = setup();
    const url = "https://example.com/no-number";
    await env.steps.branchFix([], { prUrl: url });
    const result = await prTool(contexts[0]?.toolProviders);
    expect(result.isError).toBe(true);
    expect(result.content).toContain(url);
  });
});
