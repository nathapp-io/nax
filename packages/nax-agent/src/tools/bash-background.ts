import { errorMessage } from "#src/infra/errors";
import type { RunArgvOptions } from "#src/internal/argv-exec";

export type BackgroundStream = "stdout" | "stderr";
export interface BackgroundCommandEnd {
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  /** Present when the launch itself failed. */
  readonly launchError?: string;
}
export interface BackgroundCommandHandle {
  readonly command: string;
  readonly description?: string;
  readonly origin: "agent" | "moved";
  /** Always resolves, including on launch failure. */
  readonly ended: Promise<BackgroundCommandEnd>;
  /** Immediately aborts the launch, SIGKILLing its process group. */
  stop(): void;
}
export interface BackgroundCommandSink {
  readonly id: string;
  append(stream: BackgroundStream, chunk: Uint8Array): void;
}
export interface ForegroundCommand {
  readonly command: string;
  moveToBackground(): void;
}
export interface BackgroundCommandPort {
  adopt(handle: BackgroundCommandHandle): BackgroundCommandSink;
  /** Register a foreground call; the returned function unregisters it. */
  foreground(call: ForegroundCommand): () => void;
}

export type BackgroundLaunchOptions = Pick<RunArgvOptions, "signal" | "releaseDeadline" | "onOutput">;

/** The newest raw output retained while a foreground call can still be moved. */
export const FOREGROUND_REPLAY_BYTES = 1024 * 1024;

type BackgroundResult = { content: string; isError: false };
interface LaunchResult {
  readonly launched: { readonly exitCode: number; readonly timedOut: boolean; readonly aborted?: boolean };
}
interface BashExecutionRequest<T extends LaunchResult> {
  readonly port?: BackgroundCommandPort;
  readonly runInBackground: unknown;
  readonly command: string;
  readonly description: unknown;
  readonly signal?: AbortSignal;
  readonly launch: (options?: BackgroundLaunchOptions, isForeground?: () => boolean) => Promise<T>;
}

/** Keep framing in Bash, but keep all ownership and early-return logic here. */
export async function runBashWithBackground<T extends LaunchResult>(
  request: BashExecutionRequest<T>,
): Promise<T | BackgroundResult> {
  const background = startBashBackground(request);
  if (background !== undefined) return background;
  if (request.port === undefined) return request.launch();
  return runMovableForeground({ ...request, port: request.port });
}

function outputReplay() {
  let chunks: { stream: BackgroundStream; chunk: Uint8Array }[] = [];
  let bytes = 0;
  let sink: BackgroundCommandSink | undefined;
  let replaying = false;
  return {
    append(stream: BackgroundStream, chunk: Uint8Array) {
      if (sink !== undefined) return sink.append(stream, chunk);
      if (chunk.byteLength === 0) return;
      const tail = replaying ? chunk : chunk.subarray(-FOREGROUND_REPLAY_BYTES);
      // Copy even Buffer inputs: Buffer.slice retains the original backing allocation.
      chunks.push({ stream, chunk: Uint8Array.from(tail) });
      bytes += tail.byteLength;
      while (!replaying && bytes > FOREGROUND_REPLAY_BYTES) {
        const first = chunks[0];
        if (first === undefined) break;
        const dropped = Math.min(first.chunk.byteLength, bytes - FOREGROUND_REPLAY_BYTES);
        bytes -= dropped;
        if (dropped === first.chunk.byteLength) chunks.shift();
        else first.chunk = first.chunk.slice(dropped);
      }
    },
    replay(target: BackgroundCommandSink) {
      // Drain before switching to live forwarding, including any reentrant appends.
      replaying = true;
      for (const item of chunks) target.append(item.stream, item.chunk);
      chunks = [];
      bytes = 0;
      sink = target;
    },
  };
}

function commandEnd(result: LaunchResult): BackgroundCommandEnd {
  return {
    exitCode: result.launched.exitCode,
    timedOut: result.launched.timedOut,
    aborted: result.launched.aborted === true,
  };
}

function failedEnd(error: unknown): BackgroundCommandEnd {
  return { exitCode: -1, timedOut: false, aborted: false, launchError: errorMessage(error) };
}

function foregroundControl<T extends LaunchResult>(
  request: BashExecutionRequest<T> & { readonly port: BackgroundCommandPort },
) {
  const controller = new AbortController();
  const releaseDeadline = new AbortController();
  const released = Promise.withResolvers<BackgroundResult>();
  const ended = Promise.withResolvers<BackgroundCommandEnd>();
  const output = outputReplay();
  let settled = false;
  let moved = false;
  const cancel = () => controller.abort();
  const detach = () => request.signal?.removeEventListener("abort", cancel);
  request.signal?.addEventListener("abort", cancel, { once: true });
  if (request.signal?.aborted === true) cancel();
  const call: ForegroundCommand = {
    command: request.command,
    moveToBackground() {
      if (settled || moved) return;
      moved = true;
      releaseDeadline.abort();
      detach();
      const sink = request.port.adopt({
        command: request.command,
        ...(typeof request.description === "string" ? { description: request.description } : {}),
        origin: "moved",
        ended: ended.promise,
        stop: cancel,
      });
      output.replay(sink);
      released.resolve({ content: `moved to the background as ${sink.id}`, isError: false });
    },
  };
  return {
    call,
    released: released.promise,
    options: { signal: controller.signal, releaseDeadline: releaseDeadline.signal, onOutput: output.append },
    isForeground: () => !moved,
    finish(end: BackgroundCommandEnd) {
      settled = true;
      ended.resolve(end);
    },
    detach,
  };
}

async function runMovableForeground<T extends LaunchResult>(
  request: BashExecutionRequest<T> & { readonly port: BackgroundCommandPort },
): Promise<T | BackgroundResult> {
  const control = foregroundControl(request);
  const unregister = request.port.foreground(control.call);
  const launch = Promise.resolve().then(() => request.launch(control.options, control.isForeground));
  // Observe both outcomes even after the race releases the foreground tool result.
  void launch.then(
    (result) => control.finish(commandEnd(result)),
    (error) => control.finish(failedEnd(error)),
  );
  try {
    return await Promise.race([launch, control.released]);
  } finally {
    control.detach();
    unregister();
  }
}

export function withBackgroundSentence(description: string, port?: BackgroundCommandPort): string {
  if (port === undefined) return description;
  const separator = description.endsWith(" ") ? "" : " ";
  return `${description}${separator}Set "runInBackground": true to return at once with a task id; a notice arrives when the command ends.`;
}

/** Adopt before launching so even the first output chunk has a sink. */
export function startBashBackground(request: {
  readonly port?: BackgroundCommandPort;
  readonly runInBackground: unknown;
  readonly command: string;
  readonly description: unknown;
  readonly launch: (options: BackgroundLaunchOptions) => Promise<{
    readonly launched: {
      readonly exitCode: number;
      readonly timedOut: boolean;
      readonly aborted?: boolean;
    };
  }>;
}): { content: string; isError: false } | undefined {
  if (request.port === undefined || request.runInBackground !== true) return undefined;
  const controller = new AbortController();
  const completion = Promise.withResolvers<BackgroundCommandEnd>();
  const sink = request.port.adopt({
    command: request.command,
    ...(typeof request.description === "string" ? { description: request.description } : {}),
    origin: "agent",
    ended: completion.promise,
    stop: () => controller.abort(),
  });
  // The promise boundary also settles synchronous launch failures without rejection.
  void Promise.resolve()
    .then(() =>
      request.launch({
        signal: controller.signal,
        releaseDeadline: AbortSignal.abort(),
        onOutput: (stream, chunk) => sink.append(stream, chunk),
      }),
    )
    .then(
      ({ launched }) =>
        completion.resolve({
          exitCode: launched.exitCode,
          timedOut: launched.timedOut,
          aborted: launched.aborted === true,
        }),
      (error) =>
        completion.resolve({ exitCode: -1, timedOut: false, aborted: false, launchError: errorMessage(error) }),
    );
  return { content: `started in the background as ${sink.id}`, isError: false };
}
