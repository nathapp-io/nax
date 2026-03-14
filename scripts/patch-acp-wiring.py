#!/usr/bin/env python3
"""Apply ACP registry wiring patches to nax source."""
import sys

cwd = '/home/ubuntu/subrina-coder/projects/nax/repos/nax'
ok = 0
fail = 0

def patch(path, old, new, label=''):
    global ok, fail
    full = f'{cwd}/{path}'
    with open(full) as f:
        content = f.read()
    if old not in content:
        print(f'[MISS] {label or path}')
        fail += 1
        return False
    with open(full, 'w') as f:
        f.write(content.replace(old, new, 1))
    print(f'[OK]   {label or path}')
    ok += 1
    return True

# ─── 1. pipeline/types.ts: add AgentGetFn type + agentGetFn to PipelineContext ───
patch('src/pipeline/types.ts',
    'export interface PipelineContext {',
    '''export type AgentGetFn = (name: string) => import("../agents/types").AgentAdapter | undefined;

export interface PipelineContext {''',
    'types.ts: AgentGetFn type'
)
patch('src/pipeline/types.ts',
    '  /** Interaction chain (optional, for human-in-the-loop triggers) */',
    '''  /**
   * Protocol-aware agent resolver. When set (ACP mode), returns AcpAgentAdapter;
   * falls back to standalone getAgent (CLI mode) when absent.
   */
  agentGetFn?: AgentGetFn;
  /** Interaction chain (optional, for human-in-the-loop triggers) */''',
    'types.ts: agentGetFn field'
)

# ─── 2. executor-types.ts: add AgentGetFn import + agentGetFn to SequentialExecutionContext ───
patch('src/execution/executor-types.ts',
    'import type { DeferredReviewResult } from "./deferred-review";',
    '''import type { AgentGetFn } from "../pipeline/types";
import type { DeferredReviewResult } from "./deferred-review";''',
    'executor-types.ts: AgentGetFn import'
)
patch('src/execution/executor-types.ts',
    '  interactionChain?: InteractionChain | null;\n}',
    '''  interactionChain?: InteractionChain | null;
  /** Protocol-aware agent resolver (ACP wiring). Falls back to standalone getAgent when absent. */
  agentGetFn?: AgentGetFn;
}''',
    'executor-types.ts: agentGetFn field'
)

# ─── 3. iteration-runner.ts: forward agentGetFn to pipelineContext ───
patch('src/execution/iteration-runner.ts',
    '    interaction: ctx.interactionChain ?? undefined,\n    accumulatedAttemptCost',
    '''    interaction: ctx.interactionChain ?? undefined,
    agentGetFn: ctx.agentGetFn,
    accumulatedAttemptCost''',
    'iteration-runner.ts: forward agentGetFn'
)

# ─── 4. execution stage: use ctx.agentGetFn ?? _executionDeps.getAgent ───
patch('src/pipeline/stages/execution.ts',
    '    const agent = _executionDeps.getAgent(ctx.config.autoMode.defaultAgent);',
    '    const agent = (ctx.agentGetFn ?? _executionDeps.getAgent)(ctx.config.autoMode.defaultAgent);',
    'execution.ts: use ctx.agentGetFn'
)

# ─── 5. routing stage: use ctx.agentGetFn for both decompose call sites ───
# decompose fallback (getAgent import)
patch('src/pipeline/stages/routing.ts',
    '  const agent = getAgent(config.autoMode.defaultAgent);',
    '  const agent = (ctx.agentGetFn ?? getAgent)(config.autoMode.defaultAgent);',
    'routing.ts: decompose uses ctx.agentGetFn'
)
# agent resolution (_routingDeps.getAgent)
patch('src/pipeline/stages/routing.ts',
    '    const adapter = _routingDeps.getAgent(agentName);',
    '    const adapter = (ctx.agentGetFn ?? _routingDeps.getAgent)(agentName);',
    'routing.ts: agent resolver uses ctx.agentGetFn'
)

# ─── 6. run-initialization.ts: add agentGetFn to InitializationContext, use it ───
patch('src/execution/lifecycle/run-initialization.ts',
    'import { getAgent } from "../../agents";',
    'import type { AgentGetFn } from "../../pipeline/types";',
    'run-initialization.ts: swap getAgent import for AgentGetFn type'
)
patch('src/execution/lifecycle/run-initialization.ts',
    'export interface InitializationContext {\n  config: NaxConfig;\n  prdPath: string;\n  workdir: string;\n  dryRun: boolean;\n}',
    '''export interface InitializationContext {
  config: NaxConfig;
  prdPath: string;
  workdir: string;
  dryRun: boolean;
  /** Protocol-aware agent resolver — passed from registry at run start */
  agentGetFn?: AgentGetFn;
}''',
    'run-initialization.ts: agentGetFn in context'
)
patch('src/execution/lifecycle/run-initialization.ts',
    'async function checkAgentInstalled(config: NaxConfig, dryRun: boolean): Promise<void> {\n  if (dryRun) return;\n\n  const logger = getSafeLogger();\n  const agent = getAgent(config.autoMode.defaultAgent);',
    '''async function checkAgentInstalled(config: NaxConfig, dryRun: boolean, agentGetFn?: AgentGetFn): Promise<void> {
  if (dryRun) return;

  const logger = getSafeLogger();
  const { getAgent } = await import("../../agents");
  const agent = (agentGetFn ?? getAgent)(config.autoMode.defaultAgent);''',
    'run-initialization.ts: checkAgentInstalled uses agentGetFn'
)
patch('src/execution/lifecycle/run-initialization.ts',
    '  // Check agent installation\n  await checkAgentInstalled(ctx.config, ctx.dryRun);',
    '  // Check agent installation\n  await checkAgentInstalled(ctx.config, ctx.dryRun, ctx.agentGetFn);',
    'run-initialization.ts: pass agentGetFn to checkAgentInstalled'
)

# ─── 7. run-setup.ts: pass agentGetFn to initializeRun ───
patch('src/execution/lifecycle/run-setup.ts',
    '    const initResult = await initializeRun({\n      config: ',
    '''    const initResult = await initializeRun({
      agentGetFn: options.agentGetFn,
      config: ''',
    'run-setup.ts: pass agentGetFn to initializeRun'
)

# ─── 8. acceptance-loop.ts: add agentGetFn to AcceptanceLoopContext, use it ───
patch('src/execution/lifecycle/acceptance-loop.ts',
    'import { getAgent } from "../../agents";',
    'import type { AgentGetFn } from "../../pipeline/types";',
    'acceptance-loop.ts: swap getAgent import for AgentGetFn type'
)
patch('src/execution/lifecycle/acceptance-loop.ts',
    '  statusWriter: StatusWriter;\n}',
    '''  statusWriter: StatusWriter;
  /** Protocol-aware agent resolver — passed from registry at run start */
  agentGetFn?: AgentGetFn;
}''',
    'acceptance-loop.ts: agentGetFn in AcceptanceLoopContext'
)
patch('src/execution/lifecycle/acceptance-loop.ts',
    '  const agent = getAgent(ctx.config.autoMode.defaultAgent);\n  if (!agent) {',
    '''  const { getAgent } = await import("../../agents");
  const agent = (ctx.agentGetFn ?? getAgent)(ctx.config.autoMode.defaultAgent);
  if (!agent) {''',
    'acceptance-loop.ts: generateAndAddFixStories uses agentGetFn'
)

# ─── 9. runner-completion.ts: add agentGetFn to options, pass to runAcceptanceLoop ───
patch('src/execution/runner-completion.ts',
    'import type { NaxConfig } from "../config";',
    '''import type { AgentGetFn } from "../pipeline/types";
import type { NaxConfig } from "../config";''',
    'runner-completion.ts: AgentGetFn import'
)
patch('src/execution/runner-completion.ts',
    '  pluginRegistry: PluginRegistry;\n  eventEmitter?: PipelineEventEmitter;\n}',
    '''  pluginRegistry: PluginRegistry;
  eventEmitter?: PipelineEventEmitter;
  /** Protocol-aware agent resolver */
  agentGetFn?: AgentGetFn;
}''',
    'runner-completion.ts: agentGetFn in RunnerCompletionOptions'
)
patch('src/execution/runner-completion.ts',
    '      statusWriter: options.statusWriter,\n    });',
    '''      statusWriter: options.statusWriter,
      agentGetFn: options.agentGetFn,
    });''',
    'runner-completion.ts: pass agentGetFn to runAcceptanceLoop'
)

# ─── 10. runner-execution.ts: add agentGetFn to options, thread to sequential ───
patch('src/execution/runner-execution.ts',
    'import type { ParallelExecutorOptions, ParallelExecutorResult } from "./parallel-executor";',
    '''import type { AgentGetFn } from "../pipeline/types";
import type { ParallelExecutorOptions, ParallelExecutorResult } from "./parallel-executor";''',
    'runner-execution.ts: AgentGetFn import'
)
patch('src/execution/runner-execution.ts',
    '  runParallelExecution?: (options: ParallelExecutorOptions, prd: PRD) => Promise<ParallelExecutorResult>;\n}',
    '''  runParallelExecution?: (options: ParallelExecutorOptions, prd: PRD) => Promise<ParallelExecutorResult>;
  /** Protocol-aware agent resolver — created once in runner.ts from createAgentRegistry(config) */
  agentGetFn?: AgentGetFn;
}''',
    'runner-execution.ts: agentGetFn in RunnerExecutionOptions'
)
patch('src/execution/runner-execution.ts',
    '      runId: options.runId,\n      startTime: options.startTime,\n      batchPlan,\n    },',
    '''      runId: options.runId,
      startTime: options.startTime,
      batchPlan,
      agentGetFn: options.agentGetFn,
    },''',
    'runner-execution.ts: thread agentGetFn to sequential'
)

# ─── 11. runner-setup.ts: add agentGetFn to RunnerSetupOptions ───
patch('src/execution/lifecycle/run-setup.ts',
    'import type { NaxConfig } from "../../config";',
    '''import type { AgentGetFn } from "../../pipeline/types";
import type { NaxConfig } from "../../config";''',
    'run-setup.ts: AgentGetFn import'
)
# Find the RunnerSetupOptions interface and add agentGetFn
patch('src/execution/lifecycle/run-setup.ts',
    '  skipPrecheck?: boolean;\n  headless?: boolean;',
    '''  skipPrecheck?: boolean;
  headless?: boolean;
  /** Protocol-aware agent resolver — passed from runner.ts registry */
  agentGetFn?: AgentGetFn;''',
    'run-setup.ts: agentGetFn in RunnerSetupOptions'
)

# ─── 12. runner.ts: create registry, wire agentGetFn everywhere ───
patch('src/execution/runner.ts',
    'import { stopHeartbeat } from "./crash-recovery";',
    '''import { createAgentRegistry } from "../agents/registry";
import { stopHeartbeat } from "./crash-recovery";''',
    'runner.ts: import createAgentRegistry'
)
patch('src/execution/runner.ts',
    '  const logger = getSafeLogger();\n\n  // Declare prd before',
    '''  const logger = getSafeLogger();

  // Create protocol-aware agent registry (ACP wiring — ACP-003/registry-wiring)
  const registry = createAgentRegistry(config);
  const agentGetFn = registry.getAgent.bind(registry);

  // Declare prd before''',
    'runner.ts: create registry'
)
patch('src/execution/runner.ts',
    '    skipPrecheck,\n    headless,\n    formatterMode,',
    '''    skipPrecheck,
    headless,
    formatterMode,
    agentGetFn,''',
    'runner.ts: pass agentGetFn to setup'
)
patch('src/execution/runner.ts',
    '        logFilePath,\n        runId,\n        startedAt: runStartedAt,\n        startTime,\n        formatterMode,\n        headless,\n        parallel,\n        runParallelExecution: _runnerDeps.runParallelExecution ?? undefined,',
    '''        logFilePath,
        runId,
        startedAt: runStartedAt,
        startTime,
        formatterMode,
        headless,
        parallel,
        runParallelExecution: _runnerDeps.runParallelExecution ?? undefined,
        agentGetFn,''',
    'runner.ts: pass agentGetFn to execution'
)
patch('src/execution/runner.ts',
    '      featureDir,\n      prd,\n      allStoryMetrics,\n      totalCost,\n      storiesCompleted,\n      iterations,\n      statusWriter,\n      pluginRegistry,\n      eventEmitter,\n    });',
    '''      featureDir,
      prd,
      allStoryMetrics,
      totalCost,
      storiesCompleted,
      iterations,
      statusWriter,
      pluginRegistry,
      eventEmitter,
      agentGetFn,
    });''',
    'runner.ts: pass agentGetFn to completion'
)

print(f'\n{"="*50}')
print(f'OK: {ok}  MISS: {fail}')
sys.exit(0 if fail == 0 else 1)
