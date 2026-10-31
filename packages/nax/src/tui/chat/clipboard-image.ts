/**
 * Read an image from the system clipboard (macOS via `osascript`, Linux via
 * `wl-paste` / `xclip`). Read-only; the copy side lives in `./clipboard.ts`.
 */
import { errorMessage } from "@nathapp/nax-agent/internal";

export type ClipboardImage =
  | { readonly kind: "image"; readonly bytes: Uint8Array }
  | { readonly kind: "none" }
  | { readonly kind: "unsupported" }
  | { readonly kind: "failed"; readonly reason: string };

export type ClipboardRun =
  | { readonly kind: "exited"; readonly exitCode: number; readonly stdout: Uint8Array }
  | { readonly kind: "missing" }
  | { readonly kind: "timed-out" };

/** A ctrl+v read that takes longer than this is abandoned. */
export const CLIPBOARD_READ_TIMEOUT_MS = 2_000;

const TIMED_OUT_REASON = "clipboard read timed out";
const MISSING_EXECUTABLE_CODE = "ENOENT";

const DARWIN_ARGV: readonly string[] = ["osascript", "-e", "the clipboard as «class PNGf»"];
const WAYLAND_ARGV: readonly string[] = ["wl-paste", "--no-newline", "--type", "image/png"];
const XCLIP_ARGV: readonly string[] = ["xclip", "-selection", "clipboard", "-t", "image/png", "-o"];

/** `osascript` prints clipboard PNG data as `«data PNGf<hex digits>»`. */
const PNG_DATA_PATTERN = /«data PNGf([0-9A-Fa-f]+)»/;

/** One platform's command and how to turn its stdout into image bytes. */
interface ClipboardReadPlan {
  readonly argv: readonly string[];
  /** The image bytes, or `undefined` when stdout holds no image. */
  readonly imageBytes: (stdout: Uint8Array) => Uint8Array | undefined;
}

export const _clipboardImageDeps: {
  platform: NodeJS.Platform;
  env: () => Record<string, string | undefined>;
  run: (argv: readonly string[], timeoutMs: number) => Promise<ClipboardRun>;
} = {
  platform: process.platform,
  env: () => process.env,
  run: runClipboardCommand,
};

/**
 * The command for this platform, or `undefined` when clipboard images are not
 * supported there (nothing is run).
 */
function readPlan(platform: NodeJS.Platform, env: Record<string, string | undefined>): ClipboardReadPlan | undefined {
  if (platform === "darwin") return { argv: DARWIN_ARGV, imageBytes: pngDataBytes };
  if (platform !== "linux") return undefined;
  // Wayland compositors do not expose the X clipboard; wl-paste is the only reader.
  return env.WAYLAND_DISPLAY
    ? { argv: WAYLAND_ARGV, imageBytes: nonEmptyBytes }
    : { argv: XCLIP_ARGV, imageBytes: nonEmptyBytes };
}

function nonEmptyBytes(stdout: Uint8Array): Uint8Array | undefined {
  return stdout.length > 0 ? stdout : undefined;
}

function pngDataBytes(stdout: Uint8Array): Uint8Array | undefined {
  const hex = PNG_DATA_PATTERN.exec(new TextDecoder().decode(stdout))?.[1];
  // The pattern's `+` guarantees at least one hex digit, so a match is never empty.
  return hex === undefined ? undefined : new Uint8Array(Buffer.from(hex, "hex"));
}

function isMissingExecutable(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === MISSING_EXECUTABLE_CODE;
}

/**
 * Spawn `argv` with stdout piped and stderr ignored, bounded by `timeoutMs`.
 * A child that outlives the timeout is SIGKILLed and reported `timed-out`.
 */
async function runClipboardCommand(argv: readonly string[], timeoutMs: number): Promise<ClipboardRun> {
  let proc: {
    stdout: ReadableStream<Uint8Array>;
    exited: Promise<number>;
    kill: (signal?: number | NodeJS.Signals) => void;
  };
  try {
    // nax-git-env-allow: not git: clipboard reader argv supplied by the caller
    proc = Bun.spawn([...argv], { stdout: "pipe", stderr: "ignore" });
  } catch (err) {
    if (isMissingExecutable(err)) return { kind: "missing" };
    throw err;
  }
  // Drain stdout concurrently with `exited` so a full pipe cannot deadlock the
  // child; a killed pipe errors its read, which is not a failure here.
  const stdoutRead = new Response(proc.stdout).arrayBuffer().catch(() => new ArrayBuffer(0));
  let timer: ReturnType<typeof setTimeout> | undefined;
  // `setTimeout` rather than `Bun.sleep` because the timer must be cancelled
  // as soon as the child exits (forbidden-patterns-source: mid-flight cancel).
  const expired = new Promise<"timed-out">((resolve) => {
    timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // The child won the race and already exited.
      }
      resolve("timed-out");
    }, timeoutMs);
  });
  const outcome = await Promise.race([proc.exited, expired]);
  clearTimeout(timer);
  if (outcome === "timed-out") {
    // The drain is abandoned, not awaited: a grandchild of the killed child can
    // hold the pipe open, and waiting on it would undo the timeout.
    void stdoutRead;
    return { kind: "timed-out" };
  }
  return { kind: "exited", exitCode: outcome, stdout: new Uint8Array(await stdoutRead) };
}

/** Read an image from the clipboard, distinguishing "no image" from "cannot read". */
export async function readClipboardImage(): Promise<ClipboardImage> {
  const plan = readPlan(_clipboardImageDeps.platform, _clipboardImageDeps.env());
  if (plan === undefined) return { kind: "unsupported" };
  let run: ClipboardRun;
  try {
    run = await _clipboardImageDeps.run(plan.argv, CLIPBOARD_READ_TIMEOUT_MS);
  } catch (err) {
    return { kind: "failed", reason: errorMessage(err) };
  }
  if (run.kind === "missing") return { kind: "failed", reason: `${plan.argv[0]} is not installed` };
  if (run.kind === "timed-out") return { kind: "failed", reason: TIMED_OUT_REASON };
  if (run.exitCode !== 0) return { kind: "none" };
  const bytes = plan.imageBytes(run.stdout);
  return bytes === undefined ? { kind: "none" } : { kind: "image", bytes };
}
