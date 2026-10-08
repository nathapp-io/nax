/** Runs the server exactly as the published bin does, under bun, for the stdout-purity test. */
import { runCli } from "#src/server/process-entry";

process.exitCode = await runCli(process);
