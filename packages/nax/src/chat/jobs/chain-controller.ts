import { errorMessage } from "@nathapp/nax-agent/internal";
import { NaxError } from "@/errors";
import { getLogger } from "@/logger";
import { resolveStepArgv } from "./chain-argv";
import { createChainRecord, newChainId, writeChainRecord } from "./chain-store";
import type { ChainCheck, ChainState, ChainStep, ChatChain } from "./chain-types";
import type { ChatJobs } from "./job-runner";
import type { ChatJobKind, ChatJobState } from "./job-types";

const CHAIN_ID_MAX_ATTEMPTS = 16;

export interface ChainLaunch {
  readonly kind: ChatJobKind;
  readonly argv: readonly string[];
  readonly pr?: number;
}
export type ChainAdmission =
  | { readonly kind: "card"; readonly note?: string }
  | { readonly kind: "auto"; readonly chainId: string; readonly step: number; readonly approvedAt: string };
export interface ChainSummary {
  readonly id: string;
  readonly state: ChainState;
  /** 1-based next step, absent when inactive or exhausted. */
  readonly next?: number;
  readonly steps: readonly {
    readonly step: number;
    readonly kind: ChatJobKind;
    readonly argv: readonly string[];
    readonly checkBefore?: string;
    readonly check?: ChainCheck;
    readonly job?: string;
    readonly jobState?: ChatJobState;
  }[];
  readonly costCap?: number;
  readonly spent: number;
  readonly stopReason?: string;
}
export interface ChatChains {
  active(): ChatChain | undefined;
  activate(proposal: { readonly steps: readonly ChainStep[]; readonly costCap?: number }): Promise<ChatChain>;
  admit(launch: ChainLaunch): ChainAdmission;
  isActive(chainId: string): boolean;
  started(chainId: string, step: number, jobId: string): void;
  startFailed(chainId: string, step: number, message: string): void;
  recordCheck(
    step: number,
    passed: boolean,
    note: string,
  ): { readonly ok: true } | { readonly ok: false; readonly message: string };
  stop(reason: string): ChatChain | undefined;
  summary(): ChainSummary | null;
  dispose(): void;
}
export interface ChainControllerOptions {
  readonly outputDir: string;
  readonly cwd: string;
  readonly jobs: Pick<ChatJobs, "get" | "onChange">;
  readonly sessionId: () => string;
  readonly now: () => Date;
}

/** Session-local state only: disk records are audit data, never activation input. */
class ChainController implements ChatChains {
  private current?: ChatChain;
  private activating = false;
  private next = 1;
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly options: ChainControllerOptions) {}

  active(): ChatChain | undefined {
    return this.current?.state === "active" ? this.current : undefined;
  }

  async activate(proposal: { readonly steps: readonly ChainStep[]; readonly costCap?: number }): Promise<ChatChain> {
    if (this.activating || this.active()) {
      throw new NaxError("[chat] A chain is already active", "CHAT_CHAIN_ACTIVE", { stage: "chat" });
    }
    this.activating = true;
    try {
      const chain: ChatChain = {
        schemaVersion: 1,
        id: newChainId(),
        sessionId: this.options.sessionId(),
        cwd: this.options.cwd,
        approvedAt: this.options.now().toISOString(),
        state: "active",
        steps: proposal.steps.map((step) => ({ ...step, argv: [...step.argv] })),
        ...(proposal.costCap === undefined ? {} : { costCap: proposal.costCap }),
      };
      const activated = await this.reserve(chain);
      this.current = activated;
      this.next = 1;
      return activated;
    } finally {
      this.activating = false;
    }
  }

  private async reserve(chain: ChatChain): Promise<ChatChain> {
    for (let attempt = 0; attempt < CHAIN_ID_MAX_ATTEMPTS; attempt++) {
      const candidate = attempt === 0 ? chain : { ...chain, id: newChainId() };
      if (await createChainRecord(this.options.outputDir, candidate)) return candidate;
    }
    throw new NaxError("[chat] Could not reserve a unique chain ID", "CHAT_CHAIN_WRITE_FAILED", {
      stage: "chat",
      attempts: CHAIN_ID_MAX_ATTEMPTS,
      outputDir: this.options.outputDir,
    });
  }

  admit(launch: ChainLaunch): ChainAdmission {
    const chain = this.active();
    if (!chain) return { kind: "card" };
    const reason = this.refusal(chain, launch);
    if (reason) {
      this.stop(reason);
      return { kind: "card", note: `chain ${chain.id} stopped: ${reason}` };
    }
    const step = this.next++;
    if (chain.pr === undefined && launch.pr !== undefined && chain.steps[step - 1]?.prIndex !== undefined) {
      this.current = { ...chain, pr: launch.pr };
    }
    return { kind: "auto", chainId: chain.id, step, approvedAt: chain.approvedAt };
  }

  private refusal(chain: ChatChain, launch: ChainLaunch): string | undefined {
    const step = chain.steps[this.next - 1];
    if (!step || step.kind !== launch.kind) return "off-card step";
    const argv = resolveStepArgv(step.argv, step.prIndex, launch.pr);
    if (argv.length !== launch.argv.length || argv.some((token, i) => token !== launch.argv[i])) return "off-card step";
    if (this.next > 1) {
      const previousId = chain.steps[this.next - 2]?.jobId;
      if (!previousId || this.options.jobs.get(previousId)?.state !== "succeeded") {
        return `step ${this.next - 1} has not succeeded`;
      }
    }
    if (step.checkBefore && step.check?.passed !== true) return `check "${step.checkBefore}" not recorded`;
    return undefined;
  }

  isActive(chainId: string): boolean {
    return this.active()?.id === chainId;
  }

  started(chainId: string, step: number, jobId: string): void {
    if (this.current?.id !== chainId || !this.current.steps[step - 1]) return;
    this.current = {
      ...this.current,
      steps: this.current.steps.map((entry, i) => (i === step - 1 ? { ...entry, jobId } : entry)),
    };
    this.persist(this.current);
  }

  startFailed(chainId: string, step: number, message: string): void {
    if (this.current?.id === chainId) this.stop(`step ${step} could not start: ${message}`);
  }

  recordCheck(
    step: number,
    passed: boolean,
    note: string,
  ): { readonly ok: true } | { readonly ok: false; readonly message: string } {
    const chain = this.active();
    if (!chain) return { ok: false, message: "no active chain" };
    if (step !== this.next) return { ok: false, message: `step ${step} is not the next step` };
    const entry = chain.steps[step - 1];
    if (!entry?.checkBefore) return { ok: false, message: `step ${step} has no check to record` };
    const check = { passed, note, at: this.options.now().toISOString() };
    this.current = { ...chain, steps: chain.steps.map((entry, i) => (i === step - 1 ? { ...entry, check } : entry)) };
    if (!passed) this.stop(`check "${entry.checkBefore}" did not pass: ${note}`);
    else this.persist(this.current);
    return { ok: true };
  }

  stop(reason: string): ChatChain | undefined {
    const chain = this.active();
    if (!chain) return undefined;
    this.current = { ...chain, state: "stopped", stopReason: reason, endedAt: this.options.now().toISOString() };
    this.persist(this.current);
    return this.current;
  }

  /** Serialize immutable snapshots so an older write cannot overwrite a stop or late start. */
  private persist(chain: ChatChain): void {
    this.writes = this.writes
      .then(() => writeChainRecord(this.options.outputDir, chain))
      .catch((err: unknown) => {
        getLogger()?.warn("chat", "Failed to write chain record", { chainId: chain.id, error: errorMessage(err) });
      });
  }

  summary(): ChainSummary | null {
    const chain = this.current;
    if (!chain) return null;
    return {
      id: chain.id,
      state: chain.state,
      ...(chain.state === "active" && this.next <= chain.steps.length ? { next: this.next } : {}),
      steps: chain.steps.map((entry, i) => ({
        step: i + 1,
        kind: entry.kind,
        argv: entry.argv,
        ...(entry.checkBefore === undefined ? {} : { checkBefore: entry.checkBefore }),
        ...(entry.check === undefined ? {} : { check: entry.check }),
        ...(entry.jobId === undefined ? {} : { job: entry.jobId, jobState: this.options.jobs.get(entry.jobId)?.state }),
      })),
      ...(chain.costCap === undefined ? {} : { costCap: chain.costCap }),
      spent: chain.steps.reduce(
        (sum, step) => sum + (step.jobId ? (this.options.jobs.get(step.jobId)?.cost ?? 0) : 0),
        0,
      ),
      ...(chain.stopReason === undefined ? {} : { stopReason: chain.stopReason }),
    };
  }

  // No listener or timer until job-end reconciliation is added (US-004).
  dispose(): void {}
}

export function createChainController(options: ChainControllerOptions): ChatChains {
  return new ChainController(options);
}
