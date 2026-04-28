import type { AgentAdapter } from "../agents";
import { getLogger } from "../logger";
import type { PipelineContext } from "../pipeline/types";
import { appendScratchEntry, readDigestFile, writeDigestFile } from "../session/scratch-writer";
import { errorMessage } from "../utils/errors";
import { runThreeSessionTdd } from "./orchestrator";
import type { TddSessionRole, ThreeSessionTddOptions, ThreeSessionTddResult } from "./types";

export async function runThreeSessionTddFromCtx(
  ctx: PipelineContext,
  opts: { agent: AgentAdapter; dryRun?: boolean; lite?: boolean },
): Promise<ThreeSessionTddResult> {
  let tddContextBundles: ThreeSessionTddOptions["tddContextBundles"];
  let getTddContextBundle: ThreeSessionTddOptions["getTddContextBundle"];
  let recordTddSessionOutcome: ThreeSessionTddOptions["recordTddSessionOutcome"];
  // #541: per-role session descriptor id, populated lazily when scratch dir is created.
  const sessionIdByRole = new Map<TddSessionRole, string>();
  const getTddSessionBinding: ThreeSessionTddOptions["getTddSessionBinding"] = (role) => {
    if (!ctx.sessionManager) return undefined;
    const id = sessionIdByRole.get(role);
    if (!id) return undefined;
    return { sessionManager: ctx.sessionManager, sessionId: id, agentManager: ctx.agentManager };
  };

  // Defensive check: test fixtures may bypass Zod and omit `context.v2`.
  if (ctx.config.context?.v2?.enabled) {
    const { assembleForStage } = await import("../context/engine");
    const stageByRole: Record<TddSessionRole, string> = {
      "test-writer": "tdd-test-writer",
      implementer: "tdd-implementer",
      verifier: "tdd-verifier",
    };
    const priorDigestByRole = new Map<TddSessionRole, string | undefined>();
    const scratchDirByRole = new Map<TddSessionRole, string | undefined>();
    const storyScratchDirs = new Set<string>(ctx.sessionScratchDir ? [ctx.sessionScratchDir] : []);

    const ensureRoleScratchDir = (role: TddSessionRole): string | undefined => {
      const existing = scratchDirByRole.get(role);
      if (existing !== undefined) return existing;

      let created: string | undefined;
      if (ctx.sessionManager && ctx.prd.feature) {
        // #540: the context stage (src/pipeline/stages/context.ts) pre-creates an
        // implementer-role descriptor that owns ctx.sessionId + ctx.sessionScratchDir.
        // Reuse it here instead of creating a second implementer descriptor for the
        // TDD implementer session — otherwise the run leaves two implementer
        // descriptors on disk with only one ever binding protocolIds.
        const reuseExisting =
          role === "implementer" && ctx.sessionId && ctx.sessionScratchDir
            ? ctx.sessionManager.get(ctx.sessionId)
            : undefined;
        const descriptor =
          reuseExisting ??
          ctx.sessionManager.create({
            role,
            agent: ctx.routing.agent ?? ctx.agentManager?.getDefault() ?? "claude",
            workdir: ctx.workdir,
            projectDir: ctx.projectDir,
            featureName: ctx.prd.feature,
            storyId: ctx.story.id,
          });
        created = descriptor.scratchDir;
        // #541: remember the descriptor id so runTddSession can bind handle later.
        sessionIdByRole.set(role, descriptor.id);
      } else {
        created = ctx.sessionScratchDir;
      }
      scratchDirByRole.set(role, created);
      if (created) storyScratchDirs.add(created);
      return created;
    };

    /**
     * Resolve the prior-stage digest for a TDD role. Prefers the in-memory
     * map populated by the previous role in this pipeline run; falls back to
     * reading `digest-<priorStage>.txt` from any known story scratch dir so
     * crash-resume and cross-iteration escalation keep digest continuity (M4).
     */
    const resolvePriorDigest = async (role: TddSessionRole): Promise<string | undefined> => {
      if (role === "test-writer") return ctx.contextBundle?.digest;
      const priorRole: TddSessionRole = role === "implementer" ? "test-writer" : "implementer";
      const inMemory = priorDigestByRole.get(priorRole);
      if (inMemory) return inMemory;
      const priorStageKey = stageByRole[priorRole];
      for (const dir of storyScratchDirs) {
        try {
          const onDisk = await readDigestFile(dir, priorStageKey);
          if (onDisk) return onDisk;
        } catch {
          // best-effort; missing digest is not an error
        }
      }
      return undefined;
    };

    getTddContextBundle = async (role) => {
      const scratchDir = ensureRoleScratchDir(role);
      const bundle = await assembleForStage(ctx, stageByRole[role], {
        priorStageDigest: await resolvePriorDigest(role),
        storyScratchDirs: [...storyScratchDirs],
      });
      if (bundle) {
        priorDigestByRole.set(role, bundle.digest);
        ctx.contextBundle = bundle;
        // M4: persist the digest eagerly at assemble-time so a crash before
        // session outcome still leaves a digest for the next role to pick up.
        if (scratchDir) {
          try {
            await writeDigestFile(scratchDir, stageByRole[role], bundle.digest);
          } catch (error) {
            getLogger().warn("tdd", "Failed to persist TDD stage digest — continuing", {
              storyId: ctx.story.id,
              role,
              error: errorMessage(error),
            });
          }
        }
      }
      return bundle ?? undefined;
    };

    recordTddSessionOutcome = async (result) => {
      const scratchDir = ensureRoleScratchDir(result.role);
      if (!scratchDir) return;
      try {
        await appendScratchEntry(scratchDir, {
          kind: "tdd-session",
          timestamp: new Date().toISOString(),
          storyId: ctx.story.id,
          stage: stageByRole[result.role],
          role: result.role,
          success: result.success,
          filesChanged: result.filesChanged,
          outputTail: result.outputTail ?? "",
          writtenByAgent: ctx.routing?.agent ?? ctx.agentManager?.getDefault() ?? "claude",
        });

        const digest = priorDigestByRole.get(result.role);
        if (digest) {
          await writeDigestFile(scratchDir, stageByRole[result.role], digest);
        }
      } catch (error) {
        getLogger().warn("tdd", "Failed to persist TDD session scratch — continuing", {
          storyId: ctx.story.id,
          role: result.role,
          error: errorMessage(error),
        });
      }
    };
  }

  return runThreeSessionTdd({
    agent: opts.agent,
    story: ctx.story,
    config: ctx.config,
    workdir: ctx.workdir,
    modelTier: ctx.routing.modelTier,
    featureName: ctx.prd.feature,
    contextMarkdown: ctx.contextMarkdown,
    featureContextMarkdown: ctx.featureContextMarkdown,
    tddContextBundles,
    getTddContextBundle,
    recordTddSessionOutcome,
    getTddSessionBinding,
    constitution: ctx.constitution?.content,
    dryRun: opts.dryRun ?? false,
    lite: opts.lite ?? false,
    interactionChain: ctx.interaction,
    projectDir: ctx.projectDir,
    abortSignal: ctx.abortSignal,
    agentManager: ctx.agentManager,
  });
}
