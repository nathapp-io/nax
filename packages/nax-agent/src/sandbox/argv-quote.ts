/**
 * POSIX single-quote quoting for RunCommand's Exec branch under the sandbox.
 *
 * srt wraps a command STRING that runs under `sh -c`, so a sandboxed Exec
 * call becomes `sh -c '<argv, each element quoted>'`. Inside single quotes
 * nothing is special, and an embedded quote is closed, escaped and reopened
 * ('\''), so the mapping is injective and no metacharacter is ever
 * interpreted. Lives here, not in run-command-exec.ts, whose whole-file guard
 * forbids a shell-quoting import.
 */
export function quoteArgvForShell(argv: readonly string[]): string {
  return argv.map((arg) => `'${arg.replaceAll("'", "'\\''")}'`).join(" ");
}
