import type { SessionEvent, SessionEventBody, SteerResult } from "@nathapp/nax-agent";
import { type ChatHost, createChatAskController } from "@/chat";
import { renderChat } from "@/tui/chat";

/** No providers, storage, subprocess tools or LLM calls; every turn waits for the test. */
export function createPtyHost() {
  let listener: (event: SessionEvent) => void = () => {};
  let sends = 0;
  let steers = 0;
  let idle = false;
  const gate = Promise.withResolvers<void>();
  const event = (body: SessionEventBody): SessionEvent => ({
    sessionId: "pty-session",
    turnId: "t1",
    at: "now",
    metadata: {},
    ...body,
  });
  const emit = (body: SessionEventBody) => listener(event(body));
  const end = {
    type: "turn_end",
    status: "completed",
    output: "",
    costUsd: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
  } as const;
  const host: ChatHost = {
    repoRoot: "/repo",
    models: ["model-a", "model-b"],
    current: () => ({
      sessionId: "pty-session",
      mode: "guarded",
      model: "model-a",
      meta: {
        schemaVersion: 1,
        sessionId: "pty-session",
        cwd: "/repo",
        mode: "ask",
        model: "model-a",
        bashApproval: "gated",
        title: null,
        createdAt: "now",
        updatedAt: null,
      },
    }),
    asks: createChatAskController({ mode: "guarded", answer: () => {} }),
    notice: () => undefined,
    send: async (_message, onEvent) => {
      sends++;
      listener = onEvent;
      emit({ type: "turn_start" });
      emit({ type: "text_delta", text: "Transcript sentinel", round: 1 });
      if (!idle) await gate.promise;
      emit(end);
    },
    steer: (): SteerResult => ({
      status: "accepted",
      steerId: `steer-${++steers}`,
      applied: new Promise<boolean>(() => {}),
    }),
    cancel: () => {},
    close: async () => {},
    start: async () => {},
    clear: async () => {},
    resume: async () => {},
    switchTo: async () => {},
    listSessions: async () => [],
  };
  return {
    host,
    emit,
    state: () => ({ sends, steers, idle }),
    finish: () => {
      idle = true;
      gate.resolve();
    },
  };
}

if (import.meta.main) {
  const socket = process.argv[2];
  if (!socket) throw new Error("test-owned control socket required");
  const fixture = createPtyHost();
  let ticks = 0;
  let lastBytes = "";
  // Capture bytes through the renderer's public stream boundary, without changing its options.
  const { _renderChatDeps } = await import("@/tui/chat");
  const inkRender = _renderChatDeps.render;
  _renderChatDeps.render = (node, options) =>
    inkRender(node, {
      ...options,
      stdout: Object.assign(Object.create(process.stdout), {
        write: (chunk: string) => {
          lastBytes += chunk;
          return process.stdout.write(chunk);
        },
      }),
    });
  const view = renderChat({ host: fixture.host, version: "pty-test" });
  const server = Bun.serve({
    unix: socket,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/idle") fixture.finish();
      if (path === "/tick") {
        ticks++;
        fixture.emit({ type: ticks % 2 ? "thinking_delta" : "text_delta", text: "", round: 1 });
      }
      if (path === "/bytes") {
        const bytes = lastBytes;
        lastBytes = "";
        return new Response(bytes);
      }
      if (path === "/close") {
        view.unmount();
        server.stop();
      }
      // `rows`/`columns` are what the screen under test measures: a resize case waits for the
      // app to have seen the pane's new size, not just for tmux to report it.
      return Response.json({ ...fixture.state(), ticks, rows: process.stdout.rows, columns: process.stdout.columns });
    },
  });
}
