/**
 * The one place a native `tool-result` message is constructed.
 *
 * The result used to be appended at seven separate sites in `turn-loop.ts`, so
 * there was no single point at which a policy could be applied even if one
 * existed, and invariants like "`toolCallId` is always set" were re-asserted by
 * hand at each. Every site now builds its message here.
 *
 * That chokepoint is also what makes `after_tool` safe by construction
 * (nax#2151): the event shapes a result BEFORE it enters the message array, so
 * no handler can rewrite history and re-bill the prefix-cached prompt. The four
 * synthetic sites — where no tool ran — use this builder without firing the
 * event; the three genuine sites use both.
 */

/**
 * A refusal the model is meant to act on. Structural (ADR-029 s5), never a
 * string convention: `{ answer }` alone cannot distinguish "refused, and here
 * is why" from "here is your file".
 */
export interface DenialInfo {
  readonly reason: string;
  readonly breach: boolean;
}

export interface ToolResultMessage {
  readonly role: "tool-result";
  readonly toolCallId: string;
  readonly content: string;
  readonly isError?: boolean;
  readonly denied?: DenialInfo;
}

export interface BuildToolResultArgs {
  readonly toolCallId: string;
  readonly content: string;
  readonly isError?: boolean;
  readonly denied?: DenialInfo;
}

export function buildToolResult(args: BuildToolResultArgs): ToolResultMessage {
  return {
    role: "tool-result",
    toolCallId: args.toolCallId,
    content: args.content,
    // Absent stays absent: a clean result must not carry an `isError: undefined`
    // key, so the field is spread in only when it has a value.
    ...(args.isError === undefined ? {} : { isError: args.isError }),
    ...(args.denied === undefined ? {} : { denied: args.denied }),
  };
}
