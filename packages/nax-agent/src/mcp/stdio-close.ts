/** Waits for an MCP stdio child to exit after close (S5-5 spec §3.1). Task 3 adds the SIGKILL grace. */
export async function waitForStdioExit(_pid: number, _exited: () => boolean, _graceMs: number): Promise<void> {}
