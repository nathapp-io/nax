/**
 * The human link of the ask chain (P2 design 5, 6.5a).
 *
 * An ADAPTER, not a channel: it renders an AskRequest into the interaction
 * subsystem's existing vocabulary and dispatches through the chain every other
 * consumer uses. It adds no plugin and no second prompt path. The import of
 * @/permissions is TYPE-ONLY, so `interaction -> permissions` stays a
 * compile-time edge and permissions remains extractable (master plan D8).
 *
 * The dependency is the narrow structural `AskChannel` rather than
 * `InteractionChain` itself: the link only needs `prompt` and `cancel`, and a
 * narrow boundary keeps test doubles cast-free. `InteractionChain` satisfies it
 * structurally.
 */
import type { AskLink, AskLinkOutcome, AskRequest } from "@/permissions";
import { getSafeLogger } from "../logger";
import type { InteractionRequest } from "./types";

/** Headroom under MAX_MESSAGE_CHARS (4000) for the header, reason and footer. */
const MAX_COMMAND_CHARS = 3500;

/** The subset of a response a permission prompt reads. */
export interface AskChannelResponse {
  readonly action: string;
  readonly respondedBy?: string;
  readonly value?: string;
  readonly requestId?: string;
  readonly respondedAt?: number;
}

/** The subset of the interaction channel a permission prompt needs. */
export interface AskChannel {
  prompt(request: InteractionRequest): Promise<AskChannelResponse>;
  cancel(requestId: string): Promise<void>;
}

const OPTIONS = [
  { key: "allow", label: "Allow once" },
  { key: "allow-remember", label: "Allow + remember" },
  { key: "deny", label: "Deny" },
];

/**
 * ONLY these permit. Everything else -- including unrecognised strings from a
 * future or malformed plugin -- denies. An allowlist, never a denylist.
 */
const PERMITS = new Set(["allow", "allow-remember"]);

/** An AskLink that also exposes the prompt currently awaiting a human. */
export interface HumanAskLink extends AskLink {
  pending(): string | undefined;
}

export function createHumanAskLink(opts: {
  /**
   * `PipelineContext.interaction` is declared OPTIONAL (`src/pipeline/types.ts:142`), so it is
   * `InteractionChain | undefined`, while a chain built directly is `| null`. Accept both
   * rather than making every call site remember a `?? null` under `strict`.
   */
  readonly chain: AskChannel | null | undefined;
  readonly timeoutMs: number;
  readonly featureName?: string;
  readonly storyId?: string;
  readonly onRemember?: (req: AskRequest) => Promise<void>;
}): HumanAskLink {
  // One prompt in flight per run. CLI's readline is single-in-flight
  // (plugins/cli.ts:150-160) while Telegram is concurrent, so serializing HERE
  // makes gate behaviour independent of which channel is configured.
  let queue: Promise<unknown> = Promise.resolve();
  let pendingRequestId: string | undefined;

  const deny = (decidedBy: "human" | "timeout" | "unavailable"): AskLinkOutcome => ({
    decision: "deny",
    decidedBy,
  });

  async function ask(req: AskRequest): Promise<AskLinkOutcome> {
    const chain = opts.chain;
    if (chain === null || chain === undefined) return deny("unavailable");
    const command = req.command ?? "";
    if (command.length > MAX_COMMAND_CHARS) return deny("unavailable");

    const id = `ask-${Math.random().toString(16).slice(2, 10)}`;
    pendingRequestId = id;
    try {
      const response = await chain.prompt({
        id,
        type: "choose",
        featureName: opts.featureName ?? "unknown",
        ...(opts.storyId !== undefined ? { storyId: opts.storyId } : {}),
        stage: "execution",
        summary: `${req.tool} - approval required`,
        detail: [
          // A Write/Edit ask carries no command: showing `req.summary` keeps the
          // operator informed about what is being approved instead of an empty
          // code block. The command is still shown verbatim when present.
          ...(command.length > 0 ? ["```", command, "```"] : []),
          `request: ${req.summary}`,
          `runs in: ${req.root ?? "unknown"}`,
          `reason:  ${req.reason ?? req.rule}`,
          `stage:   ${req.stage}`,
        ].join("\n"),
        options: OPTIONS,
        timeout: opts.timeoutMs,
        // Recorded for the message footer only. This link NEVER consults
        // applyFallback: it maps "continue" AND "escalate" to approve.
        fallback: "abort",
        createdAt: Date.now(),
      });
      if (response.respondedBy === "timeout") return deny("timeout");
      // `action` is declared as InteractionAction ("approve" | "reject" |
      // "choose" | "input" | "skip" | "abort"), but prompt() remaps a choose
      // reply to the OPTION KEY through a cast (src/interaction/chain.ts:135),
      // so at runtime it carries our keys. Widen to string once, here: a direct
      // `response.action === "allow-remember"` is a TS2367 "no overlap" error.
      const action: string = response.action;
      if (!PERMITS.has(action)) return deny("human");
      if (action === "allow-remember" && opts.onRemember) {
        // Remembering is AUXILIARY: the human already approved this exact call,
        // so a failed persistence (lock timeout, disk) must not revoke that
        // approval. Isolated from the outer try, which maps any throw to
        // deny("unavailable").
        try {
          await opts.onRemember(req);
        } catch (err) {
          getSafeLogger()?.warn("permissions", "[ask] approved call not remembered; allowing anyway", {
            tool: req.tool,
            stage: req.stage,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return { decision: "allow", decidedBy: "human" };
    } catch {
      return deny("unavailable");
    } finally {
      pendingRequestId = undefined;
    }
  }

  return {
    name: "human",
    resolve(req: AskRequest): Promise<AskLinkOutcome> {
      // Chain onto the queue and ALWAYS clear it, so a throw cannot leave the
      // mutex held and deadlock every later ask in the run.
      const result = queue.then(() => ask(req));
      queue = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
    pending: () => pendingRequestId,
  };
}

/**
 * Settle a prompt that is still in flight when the run ends or aborts.
 * DENY, not abstain: this is the terminal link, and a run that is ending must
 * not execute a command nobody approved.
 */
export async function cancelPendingAsk(
  chain: AskChannel | null | undefined,
  requestId: string | undefined,
): Promise<void> {
  if (chain === null || chain === undefined || requestId === undefined) return;
  await chain.cancel(requestId).catch(() => undefined);
}
