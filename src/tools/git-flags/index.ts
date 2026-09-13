/**
 * Git global options nax refuses to let any caller introduce.
 *
 * A leaf module with NO imports, deliberately. `src/tools/git.ts` imports
 * `@/utils/git`, so anything `src/utils/git.ts` reaches must not lead back to
 * `src/tools/git.ts` — see check-import-cycles (baseline 0).
 *
 * `-c` is here because `-c core.pager=<cmd>` is arbitrary code execution.
 */
export const GIT_ESCAPE_FLAGS: readonly string[] = ["-C", "--git-dir", "--work-tree", "--exec-path", "-c"];
