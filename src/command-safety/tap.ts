/**
 * The only code runtime.callTool calls (spec 4.2).
 *
 * Takes plain values rather than tool types, so src/command-safety imports
 * nothing from src/tools. Only the `Bash` and `Exec` identities are observed;
 * a RunCommand verb call runs a user-declared command and never is (D14).
 */
import { type CallIdentifiers, callIdentifiers } from "./identifiers";
import type { CommandShadow, ExecRun, LedgerOutcome, MechanicalVerdict, Observation } from "./types";

export interface ShadowTap {
  /**
   * `run` is what the Exec tool actually ran (argv after normalization, and
   * its cwd). It is forwarded to the shadow only for an `Exec` observation; a
   * `Bash` row drops it, since its executed argv is `[shell, "-c", command]`
   * and its cwd (when the caller supplied `root`) is already on the observation.
   */
  settle(ledger: LedgerOutcome, decidedBy?: string, run?: ExecRun): void;
}

export interface ShadowCall extends CallIdentifiers {
  readonly key: string;
  readonly identity: string;
  readonly command: unknown;
  readonly argv: unknown;
  /** The policy root. A Bash command starts there, so it becomes the observation's cwd. */
  readonly root?: string;
  readonly verdict: {
    readonly allowed: boolean;
    readonly outcome?: string;
    readonly breach?: boolean;
    readonly rule?: string;
  };
  readonly stage: string;
  readonly storyId?: string;
}

const NO_TAP: ShadowTap = { settle: () => undefined };

export function toMechanical(verdict: ShadowCall["verdict"]): MechanicalVerdict {
  if (verdict.allowed) return { verdict: "allow", breach: false };
  return {
    verdict: verdict.outcome === "ask" ? "ask" : "deny",
    breach: verdict.breach === true,
    ...(verdict.rule !== undefined ? { rule: verdict.rule } : {}),
  };
}

function toObservation(call: ShadowCall): Observation | undefined {
  const base = {
    stage: call.stage,
    ...(call.storyId !== undefined ? { storyId: call.storyId } : {}),
    mechanical: toMechanical(call.verdict),
    ...callIdentifiers(call),
  };
  if (call.identity === "Bash" && typeof call.command === "string") {
    return {
      command: call.command,
      identity: "Bash",
      ...base,
      ...(call.root !== undefined ? { cwd: call.root } : {}),
    };
  }
  if (call.identity === "Exec" && Array.isArray(call.argv) && call.argv.every((a) => typeof a === "string")) {
    const argv = call.argv.map(String);
    return { command: argv.join(" "), identity: "Exec", argv, ...base };
  }
  return undefined;
}

/** Observe now; settle later, exactly once. Never throws. */
export function openShadowTap(shadow: CommandShadow | undefined, call: ShadowCall): ShadowTap {
  if (shadow === undefined) return NO_TAP;
  try {
    const obs = toObservation(call);
    if (obs === undefined) return NO_TAP;
    shadow.observe(call.key, obs);
    let settled = false;
    return {
      settle(ledger, decidedBy, run) {
        if (settled) return;
        settled = true;
        try {
          const outcome = { ledger, ...(decidedBy !== undefined ? { decidedBy } : {}) };
          // Forward `run` for an Exec observation only: a Bash row's executed
          // argv is `[shell, "-c", command]`, which the row's own `command`
          // already states, so passing it would add a redundant key.
          if (obs.identity === "Exec" && run !== undefined) {
            shadow.settle(call.key, outcome, run);
          } else {
            shadow.settle(call.key, outcome);
          }
        } catch {
          // A shadow failure stops the row, never the call (spec 4.3).
        }
      },
    };
  } catch {
    // Same contract as settle: the tap is total.
    return NO_TAP;
  }
}
