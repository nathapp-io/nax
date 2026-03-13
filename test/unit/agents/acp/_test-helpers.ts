/**
 * Shared test helpers for ACP adapter tests.
 *
 * Provides mock Bun.spawn process objects and common utilities
 * for testing the acpx CLI-based adapter.
 */

import { _acpAdapterDeps } from "../../../../src/agents/acp";

/**
 * Create a mock process that returns the given stdout text and exit code.
 * Compatible with the _acpAdapterDeps.spawn() return type.
 */
export function mockProcess(
  stdout: string,
  exitCode = 0,
  stderr = "",
): ReturnType<typeof _acpAdapterDeps.spawn> {
  const encoder = new TextEncoder();
  return {
    stdout: new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(stdout));
        controller.close();
      },
    }),
    stderr: new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(stderr));
        controller.close();
      },
    }),
    stdin: {
      write: (_data: string | Uint8Array) => 0,
      end: () => {},
      flush: () => {},
    },
    exited: Promise.resolve(exitCode),
    pid: Math.floor(Math.random() * 90000) + 10000,
    kill: () => {},
  };
}

/**
 * Create a mock process that writes stdin-accepting NDJSON output.
 * Used for tests where prompt is passed via --file - (stdin).
 */
export function mockAcpxProcess(opts: {
  text?: string;
  tokenUsage?: { input_tokens: number; output_tokens: number };
  stopReason?: string;
  exitCode?: number;
  error?: string;
}): ReturnType<typeof _acpAdapterDeps.spawn> {
  const events: string[] = [];

  if (opts.text) {
    events.push(JSON.stringify({ result: opts.text }));
  }
  if (opts.tokenUsage) {
    events.push(JSON.stringify({ cumulative_token_usage: opts.tokenUsage }));
  }
  if (opts.stopReason) {
    events.push(JSON.stringify({ stopReason: opts.stopReason }));
  }
  if (opts.error) {
    events.push(JSON.stringify({ error: opts.error }));
  }

  const stdout = events.join("\n");
  return mockProcess(stdout, opts.exitCode ?? 0);
}

/**
 * Capture the command array passed to spawn.
 * Returns [capturedCmd, restore] pair.
 */
export function captureCmdSpy(): [() => string[], () => void] {
  let captured: string[] = [];
  const original = _acpAdapterDeps.spawn;

  _acpAdapterDeps.spawn = (cmd, opts) => {
    captured = cmd;
    return mockProcess("mock output", 0);
  };

  return [
    () => captured,
    () => {
      _acpAdapterDeps.spawn = original;
    },
  ];
}

/**
 * Install a spawn mock that returns the given process mock.
 * Returns a restore function.
 */
export function installSpawnMock(
  processMock: ReturnType<typeof _acpAdapterDeps.spawn>,
): () => void {
  const original = _acpAdapterDeps.spawn;
  _acpAdapterDeps.spawn = () => processMock;
  return () => {
    _acpAdapterDeps.spawn = original;
  };
}
