/**
 * `@nathapp/nax-agent-acp/server`: the nax-agent ACP server (S5). `runCli(process)`
 * is what the `nax-agent` bin runs; `main(deps)` runs it on any streams.
 */
export { type MainDeps, main } from "#src/server/main";
export { type ProcessLike, runCli } from "#src/server/process-entry";
