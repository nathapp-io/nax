import type { IAgentManager } from "@/agents";
import type { NaxConfig } from "@/config";
import type { DeferredRegressionOptions } from "@/execution";
import type { PRD, UserStory } from "@/prd";
import type { NaxRuntime } from "@/runtime";
import type { ThreeSessionTddOptions } from "@/tdd";
import type { RectificationLoopOptions } from "@/verification/rectification-loop";

type Assert<T extends true> = T;
type IsRequired<T> = undefined extends T ? false : true;

type _deferredRegressionRuntimeRequired = Assert<IsRequired<DeferredRegressionOptions["runtime"]>>;
type _tddRuntimeRequired = Assert<IsRequired<ThreeSessionTddOptions["runtime"]>>;
type _rectificationLoopRuntimeRequired = Assert<IsRequired<RectificationLoopOptions["runtime"]>>;

declare const config: NaxConfig;
declare const prd: PRD;
declare const story: UserStory;
declare const agentManager: IAgentManager;
declare const runtime: NaxRuntime;

const _validDeferredRegressionOptions: DeferredRegressionOptions = {
  config,
  prd,
  workdir: "/tmp/test",
  runtime,
};
void _validDeferredRegressionOptions;

// @ts-expect-error runtime is required for deferred regression
const _missingDeferredRegressionRuntime: DeferredRegressionOptions = {
  config,
  prd,
  workdir: "/tmp/test",
};
void _missingDeferredRegressionRuntime;

const _legacyDeferredRegressionAgentManager: DeferredRegressionOptions = {
  config,
  prd,
  workdir: "/tmp/test",
  // @ts-expect-error agentManager is no longer accepted on deferred regression options
  agentManager,
  runtime,
};
void _legacyDeferredRegressionAgentManager;

declare const agent: ThreeSessionTddOptions["agent"];

const _validThreeSessionTddOptions: ThreeSessionTddOptions = {
  agent,
  story,
  config,
  workdir: "/tmp/test",
  modelTier: "balanced",
  agentManager,
  runtime,
};
void _validThreeSessionTddOptions;

// @ts-expect-error runtime is required for TDD orchestration
const _missingThreeSessionRuntime: ThreeSessionTddOptions = {
  agent,
  story,
  config,
  workdir: "/tmp/test",
  modelTier: "balanced",
  agentManager,
};
void _missingThreeSessionRuntime;

const _validRectificationLoopOptions: RectificationLoopOptions = {
  config,
  workdir: "/tmp/test",
  story,
  testCommand: "bun test",
  timeoutSeconds: 30,
  testOutput: "failing output",
  agentManager,
  runtime,
};
void _validRectificationLoopOptions;

// @ts-expect-error runtime is required for the rectification loop
const _missingRectificationLoopRuntime: RectificationLoopOptions = {
  config,
  workdir: "/tmp/test",
  story,
  testCommand: "bun test",
  timeoutSeconds: 30,
  testOutput: "failing output",
  agentManager,
};
void _missingRectificationLoopRuntime;
