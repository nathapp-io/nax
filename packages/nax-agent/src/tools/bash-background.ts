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
