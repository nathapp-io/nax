/**
 * The child environment nax-finish hands to `acpx flow run`.
 *
 * Split out of `plugin.test.ts` (800-line test cap) and, more importantly,
 * because these tests are the only ones in the suite that must control ambient
 * `process.env`. Keeping them together makes the hermetic setup one block
 * rather than a trap for the next test added to the big file.
 *
 * The bug that motivated the split (#1506): `plugin.test.ts` asserted the
 * reviewer-profile keys were `undefined` in the child env, but never set them in
 * `process.env` first — so the assertion passed whether or not `buildFlowEnv`
 * stripped anything. It also read ambient env, so when the repo's own suite ran
 * *inside* a nax-finish flow it inherited the exported profiles and failed,
 * which is what put a production change into the gate phase to begin with.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { _naxFinishDeps, naxFinishPlugin } from "@/plugins";
import type { PostRunContext } from "@/plugins/types";

const action = naxFinishPlugin.extensions.postRunAction!;

const origDeps = { ...(_naxFinishDeps as Record<string, unknown>) };

/**
 * Every var `buildFlowEnv` is responsible for. Cleared before each test and
 * restored after, so these tests behave identically inside and outside a
 * nax-finish flow — the hermeticity this file exists to guarantee.
 */
const MANAGED_KEYS = [
  "NAX_FINISH_SPEC_PROFILE",
  "NAX_FINISH_QUALITY_PROFILE",
  "NAX_FINISH_NARRATIVE_PROFILE",
  "NAX_FINISH_NARRATIVE",
] as const;

let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const k of MANAGED_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  Object.assign(_naxFinishDeps, origDeps);
  for (const k of MANAGED_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

const baseCtx = (over: Partial<PostRunContext> = {}): PostRunContext =>
  ({
    runId: "r",
    feature: "x",
    workdir: "/repo",
    prdPath: "/repo/.nax/features/x/prd.json",
    branch: "feat/x",
    totalDurationMs: 1,
    totalCost: 0,
    storySummary: { completed: 2, failed: 0, skipped: 0, paused: 0 },
    stories: [],
    config: { finish: { autoFlow: { enabled: true } } },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    ...over,
  }) as unknown as PostRunContext;

/** Run the action and hand back the env it passed to the child process. */
async function capturedChildEnv(ctx: PostRunContext = baseCtx()): Promise<Record<string, string>> {
  let env: Record<string, string> = {};
  _naxFinishDeps.run = async (_cmd, opts) => {
    env = opts.env ?? {};
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  _naxFinishDeps.readResult = async () => ({ feature: "x", status: "opened" });
  await action.execute(ctx);
  return env;
}

describe("buildFlowEnv — reviewer profiles", () => {
  // The real regression test for the strip. This process may itself have been
  // launched by an outer nax-finish flow, which exports these vars; with no
  // reviewer configured, that ambient value must NOT reach the child. Deleting
  // the destructure in `buildFlowEnv` fails exactly this test and no other.
  test("strips an inherited profile when no reviewer is configured", async () => {
    process.env.NAX_FINISH_SPEC_PROFILE = "leaked-from-outer-flow";
    process.env.NAX_FINISH_QUALITY_PROFILE = "leaked-from-outer-flow";
    process.env.NAX_FINISH_NARRATIVE_PROFILE = "leaked-from-outer-flow";

    const env = await capturedChildEnv();

    expect(env.NAX_FINISH_SPEC_PROFILE).toBeUndefined();
    expect(env.NAX_FINISH_QUALITY_PROFILE).toBeUndefined();
    expect(env.NAX_FINISH_NARRATIVE_PROFILE).toBeUndefined();
  });

  test("a configured reviewer overrides the inherited value rather than appending to it", async () => {
    process.env.NAX_FINISH_SPEC_PROFILE = "leaked-from-outer-flow";
    const ctx = baseCtx({
      config: { finish: { autoFlow: { enabled: true, reviewers: { spec: "my-spec-profile" } } } },
    } as Partial<PostRunContext>);

    const env = await capturedChildEnv(ctx);

    expect(env.NAX_FINISH_SPEC_PROFILE).toBe("my-spec-profile");
  });

  test("omits the profile keys entirely when no reviewer is configured and none is inherited", async () => {
    const env = await capturedChildEnv();
    expect(env.NAX_FINISH_SPEC_PROFILE).toBeUndefined();
    expect(env.NAX_FINISH_QUALITY_PROFILE).toBeUndefined();
  });

  test("leaves unrelated environment variables untouched", async () => {
    const env = await capturedChildEnv();
    expect(env.PATH).toBe(process.env.PATH as string);
  });
});

describe("buildFlowEnv — narrative switch", () => {
  // The original strip covered the three *_PROFILE vars and stopped there,
  // leaving NAX_FINISH_NARRATIVE with the identical leak: an outer flow that
  // disabled narration exported `0`, and every inner flow inherited it and went
  // silent. Same failure mode, one variable further along.
  test("strips an inherited NAX_FINISH_NARRATIVE when narration is enabled", async () => {
    process.env.NAX_FINISH_NARRATIVE = "0";

    const env = await capturedChildEnv();

    expect(env.NAX_FINISH_NARRATIVE).toBeUndefined();
  });

  test("still signals the disabled case explicitly", async () => {
    const ctx = baseCtx({
      config: { finish: { autoFlow: { enabled: true, narrative: false } } },
    } as Partial<PostRunContext>);

    const env = await capturedChildEnv(ctx);

    expect(env.NAX_FINISH_NARRATIVE).toBe("0");
  });
});
