import { describeExecAllowlist } from "./exec-allowlist-text";

/**
 * The extra clause `policy.ts`'s `verbBranch` appends to a subcommand denial
 * when the tool also offers an argv escape hatch (`scope.argvField`).
 *
 * run-2026-09-14T05-55-54-734Z, Shape B: an agent with argv available still
 * stuffed raw shell into the verb field repeatedly rather than ever trying
 * "argv" -- so the structural fact ("this field is never a shell string") is
 * stated unconditionally. But a bare "use argv instead" would have sent
 * every one of the audit's four real denials straight into a SECOND one:
 * the compiled Exec grant was install-only (`bun install`, `bun add*`, ...)
 * against requests like "bun test ... | head -200" and "wc". So the actual
 * compiled grant is named here too, using the identical text
 * `describeExecAllowlist` already renders into the tool description, which
 * is what lets an agent see in one denial whether argv would help at all
 * before spending a second turn finding out.
 *
 * Extracted from `policy.ts` into its own module so that file (already at
 * its 600-line limit) can carry this explanation without trimming it.
 *
 * The clause names `argvField` explicitly ("argv" accepts: ...) rather than
 * appending `describeExecAllowlist`'s bare "permitted forms: ..." after the
 * structural sentence: two unlabelled "permitted ..." lists back to back --
 * one for `verbField`'s enum, one for argv's grant -- reads as a single
 * list, and an agent can misread the second half as more legal values for
 * `verbField`, denying again on the enum (the very second-denial loop this
 * exists to prevent). `describeExecAllowlist`'s own text is unchanged: the
 * tool description's surrounding sentence already establishes argv as the
 * subject there, so this supplies its own framing around the same list
 * rather than editing shared text to fit one caller.
 */
export function argvShellHint(
  verbField: string,
  argvField: string | undefined,
  execPatterns: readonly string[],
): string {
  if (argvField === undefined) return "";
  return ` -- "${verbField}" never takes a shell string -- "${argvField}" accepts: ${describeExecAllowlist(execPatterns)}`;
}
