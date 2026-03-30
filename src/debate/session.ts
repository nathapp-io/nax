/**
 * DebateSession
 *
 * Orchestrates a multi-agent debate for a single pipeline stage.
 * Resolves adapters, runs proposal and critique rounds, and calls the configured resolver.
 */

import type { AcpClient, AcpSession, AcpSessionResponse } from "../agents/acp/adapter";
import { createSpawnAcpClient } from "../agents/acp/spawn-client";
import { getAgent } from "../agents/registry";
import type { AgentAdapter } from "../agents/types";
import { getSafeLogger } from "../logger";
import { buildCritiquePrompt } from "./prompts";
import { judgeResolver, majorityResolver, synthesisResolver } from "./resolvers";
import type { DebateResult, DebateStageConfig, Debater, Proposal } from "./types";

/** Fallback agent name used when resolver.agent is not specified for synthesis/judge */
const RESOLVER_FALLBACK_AGENT = "synthesis";

export interface DebateSessionOptions {
  storyId: string;
  stage: string;
  stageConfig: DebateStageConfig;
}

/** Injectable deps for testability */
export const _debateSessionDeps = {
  getAgent: getAgent as (name: string) => AgentAdapter | undefined,
  getSafeLogger: getSafeLogger as () => ReturnType<typeof getSafeLogger>,
  createSpawnAcpClient: (cmdStr: string, cwd?: string): AcpClient => createSpawnAcpClient(cmdStr, cwd),
};

interface ResolvedDebater {
  debater: Debater;
  adapter: AgentAdapter;
}

interface SuccessfulProposal {
  debater: Debater;
  adapter: AgentAdapter;
  output: string;
  /** Cost for this complete() call in USD. Always 0 until complete() exposes cost metadata. */
  cost: number;
}

function buildFailedResult(
  storyId: string,
  stage: string,
  stageConfig: DebateStageConfig,
  totalCostUsd = 0,
): DebateResult {
  return {
    storyId,
    stage,
    outcome: "failed",
    rounds: 0,
    debaters: [],
    resolverType: stageConfig.resolver.type,
    proposals: [],
    totalCostUsd,
  };
}

function extractSessionOutput(response: AcpSessionResponse): string {
  const messages = response.messages ?? [];
  const last = [...messages].reverse().find((m) => m.role === "assistant");
  return last?.content ?? "";
}

export class DebateSession {
  private readonly storyId: string;
  private readonly stage: string;
  private readonly stageConfig: DebateStageConfig;

  constructor(opts: DebateSessionOptions) {
    this.storyId = opts.storyId;
    this.stage = opts.stage;
    this.stageConfig = opts.stageConfig;
  }

  async run(prompt: string): Promise<DebateResult> {
    const sessionMode = this.stageConfig.sessionMode ?? "one-shot";

    if (sessionMode === "stateful") {
      return this.runStateful(prompt);
    }

    return this.runOneShot(prompt);
  }

  private async runStateful(prompt: string): Promise<DebateResult> {
    const logger = _debateSessionDeps.getSafeLogger();
    const config = this.stageConfig;
    const debaters = config.debaters ?? [];
    const totalCostUsd = 0;

    // Resolve adapters — skip unavailable agents
    const resolved: ResolvedDebater[] = [];
    for (const debater of debaters) {
      const adapter = _debateSessionDeps.getAgent(debater.agent);
      if (!adapter) {
        logger?.warn("debate", `Agent '${debater.agent}' not found — skipping debater`);
        continue;
      }
      resolved.push({ debater, adapter });
    }

    interface SessionEntry {
      debater: Debater;
      adapter: AgentAdapter;
      session: AcpSession;
    }

    const sessions: SessionEntry[] = [];

    try {
      // Create SpawnAcpClient and session per debater
      for (let i = 0; i < resolved.length; i++) {
        const { debater, adapter } = resolved[i];
        const cmdStr = `acpx --model ${debater.model} ${debater.agent}`;
        const client = _debateSessionDeps.createSpawnAcpClient(cmdStr);
        const sessionName = `nax-debate-${this.storyId}-${i}`;

        try {
          const session = await client.createSession({
            agentName: debater.agent,
            permissionMode: "approve-reads",
            sessionName,
          });
          sessions.push({ debater, adapter, session });
        } catch {
          logger?.warn("debate", `Failed to create session for '${debater.agent}' — skipping`);
        }
      }

      // Fewer than 2 sessions created — AC5 requires minimum 2 debaters
      if (sessions.length < 2) {
        return buildFailedResult(this.storyId, this.stage, config, totalCostUsd);
      }

      // Proposal round — parallel via Promise.allSettled
      const proposalSettled = await Promise.allSettled(sessions.map(({ session }) => session.prompt(prompt)));

      const successfulSessions: Array<{ entry: SessionEntry; output: string; originalIndex: number }> = [];
      for (let i = 0; i < proposalSettled.length; i++) {
        const r = proposalSettled[i];
        if (r.status === "fulfilled") {
          successfulSessions.push({
            entry: sessions[i],
            output: extractSessionOutput(r.value),
            originalIndex: i,
          });
        }
      }

      // AC5: minimum 2 debaters required for a valid debate
      if (successfulSessions.length < 2) {
        return buildFailedResult(this.storyId, this.stage, config, totalCostUsd);
      }

      // Critique round (when rounds > 1)
      // In stateful mode, send only OTHER debaters' proposals — session retains own history.
      // proposalOutputs is indexed by position within successfulSessions (dense, 0..N-1),
      // so we use successfulIdx (not originalIndex) when calling buildCritiquePrompt to
      // correctly exclude each debater's own proposal from the critique context.
      let critiqueOutputs: string[] = [];
      if (config.rounds > 1) {
        const proposalOutputs = successfulSessions.map((s) => s.output);
        const critiqueSettled = await Promise.allSettled(
          successfulSessions.map(({ entry }, successfulIdx) =>
            entry.session.prompt(buildCritiquePrompt(prompt, proposalOutputs, successfulIdx)),
          ),
        );
        critiqueOutputs = critiqueSettled
          .filter((r): r is PromiseFulfilledResult<AcpSessionResponse> => r.status === "fulfilled")
          .map((r) => extractSessionOutput(r.value));
      }

      // Resolve outcome
      const proposalOutputs = successfulSessions.map((s) => s.output);
      const successfulProposals: SuccessfulProposal[] = successfulSessions.map((s) => ({
        debater: s.entry.debater,
        adapter: s.entry.adapter,
        output: s.output,
        cost: 0,
      }));
      const outcome = await this.resolve(proposalOutputs, critiqueOutputs, successfulProposals);

      const proposals: Proposal[] = successfulSessions.map((s) => ({
        debater: s.entry.debater,
        output: s.output,
      }));

      return {
        storyId: this.storyId,
        stage: this.stage,
        outcome,
        rounds: config.rounds,
        debaters: successfulSessions.map((s) => s.entry.debater.agent),
        resolverType: config.resolver.type,
        proposals,
        totalCostUsd,
      };
    } finally {
      await Promise.allSettled(sessions.map(({ session }) => session.close()));
    }
  }

  private async runOneShot(prompt: string): Promise<DebateResult> {
    const logger = _debateSessionDeps.getSafeLogger();
    const config = this.stageConfig;
    const debaters = config.debaters ?? [];
    let totalCostUsd = 0;

    // Step 1: Resolve adapters — skip unavailable agents
    const resolved: ResolvedDebater[] = [];
    for (const debater of debaters) {
      const adapter = _debateSessionDeps.getAgent(debater.agent);
      if (!adapter) {
        logger?.warn("debate", `Agent '${debater.agent}' not found — skipping debater`);
        continue;
      }
      resolved.push({ debater, adapter });
    }

    // Step 2: Proposal round — parallel via Promise.allSettled
    const proposalSettled = await Promise.allSettled(
      resolved.map(({ debater, adapter }) =>
        adapter
          .complete(prompt, { model: debater.model })
          // complete() returns string only — cost is 0 until the interface exposes cost metadata
          .then((output) => ({ debater, adapter, output, cost: 0 })),
      ),
    );

    const successful: SuccessfulProposal[] = proposalSettled
      .filter((r): r is PromiseFulfilledResult<SuccessfulProposal> => r.status === "fulfilled")
      .map((r) => r.value);

    // Accumulate proposal round costs
    for (const r of proposalSettled) {
      if (r.status === "fulfilled") {
        totalCostUsd += r.value.cost;
      }
    }

    // Step 3: Fewer than 2 succeeded — single-agent fallback
    if (successful.length < 2) {
      if (successful.length === 1) {
        const solo = successful[0];
        return {
          storyId: this.storyId,
          stage: this.stage,
          outcome: "passed",
          rounds: 1,
          debaters: [solo.debater.agent],
          resolverType: config.resolver.type,
          proposals: [{ debater: solo.debater, output: solo.output }],
          totalCostUsd,
        };
      }

      // All debaters failed — attempt fresh complete() on first resolved adapter (AC4)
      if (resolved.length > 0) {
        const { adapter: fallbackAdapter, debater: fallbackDebater } = resolved[0];
        try {
          const fallbackOutput = await fallbackAdapter.complete(prompt, { model: fallbackDebater.model });
          // cost from fresh fallback call — 0 until complete() exposes cost metadata
          return {
            storyId: this.storyId,
            stage: this.stage,
            outcome: "passed",
            rounds: 1,
            debaters: [fallbackDebater.agent],
            resolverType: config.resolver.type,
            proposals: [{ debater: fallbackDebater, output: fallbackOutput }],
            totalCostUsd,
          };
        } catch {
          // Fallback also failed — fall through to buildFailedResult
        }
      }

      return buildFailedResult(this.storyId, this.stage, config, totalCostUsd);
    }

    // Step 4: Critique rounds (when rounds > 1)
    let critiqueOutputs: string[] = [];
    if (config.rounds > 1) {
      const proposalOutputs = successful.map((p) => p.output);
      const critiqueSettled = await Promise.allSettled(
        successful.map(({ debater, adapter }, i) =>
          adapter.complete(buildCritiquePrompt(prompt, proposalOutputs, i), {
            model: debater.model,
          }),
        ),
      );
      // Accumulate critique round costs (0 until complete() exposes cost metadata)
      for (const r of critiqueSettled) {
        if (r.status === "fulfilled") {
          totalCostUsd += 0;
        }
      }
      critiqueOutputs = critiqueSettled
        .filter((r): r is PromiseFulfilledResult<string> => r.status === "fulfilled")
        .map((r) => r.value);
    }

    // Step 5: Resolve outcome
    const proposalOutputs = successful.map((p) => p.output);
    const outcome = await this.resolve(proposalOutputs, critiqueOutputs, successful);
    // Accumulate resolver cost (0 until complete() exposes cost metadata)
    totalCostUsd += 0;

    const proposals: Proposal[] = successful.map((p) => ({
      debater: p.debater,
      output: p.output,
    }));

    return {
      storyId: this.storyId,
      stage: this.stage,
      outcome,
      rounds: config.rounds,
      debaters: successful.map((p) => p.debater.agent),
      resolverType: config.resolver.type,
      proposals,
      totalCostUsd,
    };
  }

  private async resolve(
    proposalOutputs: string[],
    critiqueOutputs: string[],
    successful: SuccessfulProposal[],
  ): Promise<"passed" | "failed" | "skipped"> {
    const resolverConfig = this.stageConfig.resolver;

    if (resolverConfig.type === "majority-fail-closed" || resolverConfig.type === "majority-fail-open") {
      return majorityResolver(proposalOutputs);
    }

    if (resolverConfig.type === "synthesis") {
      const agentName = resolverConfig.agent ?? RESOLVER_FALLBACK_AGENT;
      const adapter = _debateSessionDeps.getAgent(agentName);
      if (adapter) {
        await synthesisResolver(proposalOutputs, critiqueOutputs, { adapter });
      }
      return "passed";
    }

    if (resolverConfig.type === "custom") {
      await judgeResolver(proposalOutputs, critiqueOutputs, resolverConfig, {
        getAgent: _debateSessionDeps.getAgent,
        defaultAgentName: RESOLVER_FALLBACK_AGENT,
      });
      return "passed";
    }

    return "passed";
  }
}
