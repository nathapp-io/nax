# Chat layout: physical-terminal resize regression

From the repository root:

```sh
cd packages/nax
timeout -k 5s 90s bun test ./test/integration/tui/chat/resize.test.ts --timeout=60000
```

Requires Bun (the repository-pinned version), installed workspace dependencies, `tmux`, and permission to create a Unix socket and a real PTY under the test temporary directory. A parent interactive terminal is not required. Sandboxes that allow finding `tmux` but prevent its server from surviving do not qualify. The test prints `SKIP chat layout real PTY: <reason>` when the capability probe fails. Use a short `TMPDIR` if the platform's Unix-socket path limit is exceeded.

The fixture imports **source `renderChat`**, not the bundled CLI. It has a deterministic fake host, no provider credentials and no LLM calls. Each case starts two independent sessions on a unique test-owned tmux server: the resized chat and an equivalent never-resized reference. Complete captured screens must match, including blank space, header and footer, rather than merely containing a status string. Event timestamps are deliberately non-date fixture values (`now`), fixing elapsed time and spinner phase while real status timers remain alive.

Cases exercise four queued messages, seventeen unresolved accepted steers, and a tiny diagnostic cycle. They resize 80x24 → 80x12 → 80x24 (also 80x2 in the diagnostic case), alternate Thinking/Writing updates repeatedly, and return to idle. Explicit IPC counters, dimensions, cleared input and frame predicates drive bounded waits. Tick output is checked for full-screen clears. The never-resized reference accounts for legitimate transcript changes during phase transitions and queue draining.

`finally` kills only the server at the test's unique socket and removes only its temporary directory, including the two control sockets. This closes its panes and fixture processes on success or failure; no default tmux socket or unrelated session is addressed. Existing `index.test.tsx` assertions separately pin mouse-disable, alternate-screen leave, saved-title restoration and setup-error restoration. The renderer remains incremental; the fitted source frame passes without another Ink patch or resize clear.

Mandatory mounted/pure checks remain enabled even when PTY execution is skipped:

```sh
timeout 30 bun test ./test/ui/chat/chat-app-geometry.test.tsx ./test/ui/chat/chat-app-suspension.test.tsx ./test/ui/chat/jobs-opener.test.tsx ./test/ui/chat/transcript-viewport.test.tsx ./test/unit/tui/chat/selection.test.ts --timeout=5000
```

No coverage floors are changed for capability skips. Run the normal package gates (`bun run typecheck`, `bun run check:all`, `bun run test`) before merging.
