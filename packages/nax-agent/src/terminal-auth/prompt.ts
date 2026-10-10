/**
 * Terminal prompts for credential entry (moved from the nax CLI, S5-4 M-28).
 *
 * Nothing typed into a secret prompt is echoed, and the terminal is restored on
 * every exit path: submit, cancel, stream end and stream error. Ctrl+D cancels;
 * it never submits (it once fell through to "submit" in nax's confirm prompt).
 */

/** Ctrl+C. */
const ETX = "\u0003";
/** Ctrl+D. Conventionally cancel, never submit. */
const EOT = "\u0004";
const CR = "\r";
const LF = "\n";
const BACKSPACE = "\u007F";
const ARROW_UP = "\u001b[A";
const ARROW_DOWN = "\u001b[B";

/** Colours for the prompts; the caller supplies them (nax passes chalk). */
export interface TerminalStyle {
  accent(text: string): string;
  dim(text: string): string;
  bold(text: string): string;
}

const identity = (text: string): string => text;

export const PLAIN_STYLE: TerminalStyle = { accent: identity, dim: identity, bold: identity };

/** The slice of process.stdin these prompts drive. Injected so tests can stand one up. */
export interface PromptStdin {
  isTTY?: boolean;
  setRawMode(mode: boolean): unknown;
  resume(): unknown;
  pause(): unknown;
  setEncoding(encoding: string): unknown;
  on(event: string, listener: (chunk: string) => void): unknown;
  once(event: string, listener: () => void): unknown;
  removeListener(event: string, listener: (...args: never[]) => void): unknown;
}

export class PromptCancelledError extends Error {
  constructor() {
    super("Prompt cancelled");
    this.name = "PromptCancelledError";
  }
}

/**
 * Test seam. `stdin` is unset by default and resolved to `process.stdin` only
 * when a prompt runs: this module is reachable from the public barrel, and
 * touching `process.stdin` at import would open it for every consumer.
 */
export const _terminalPromptDeps: {
  stdin: PromptStdin | undefined;
  write: (text: string) => boolean;
} = {
  stdin: undefined,
  write: (text: string) => process.stdout.write(text),
};

function stdinOf(): PromptStdin {
  return _terminalPromptDeps.stdin ?? (process.stdin as unknown as PromptStdin);
}

type KeyAction =
  | { readonly kind: "cancel" }
  | { readonly kind: "submit" }
  | { readonly kind: "empty-submit" }
  | { readonly kind: "erase" }
  | { readonly kind: "append" };

/** What one typed character does to a line prompt. */
function keyAction(char: string, bufferEmpty: boolean, hasEmptyHook: boolean): KeyAction {
  if (char === ETX || char === EOT) return { kind: "cancel" };
  if (char === CR || char === LF) {
    return bufferEmpty && hasEmptyHook ? { kind: "empty-submit" } : { kind: "submit" };
  }
  if (char === BACKSPACE) return { kind: "erase" };
  return { kind: "append" };
}

/** Applies a non-terminal key to the buffer; echoes when the prompt is visible. */
function applyEdit(
  action: KeyAction,
  char: string,
  buffer: string,
  echo: boolean,
  onEmptySubmit: (() => void) | undefined,
): string {
  if (action.kind === "empty-submit") {
    onEmptySubmit?.();
    return buffer;
  }
  if (action.kind === "erase") {
    if (echo) _terminalPromptDeps.write("\b \b");
    return buffer.slice(0, -1);
  }
  if (echo) _terminalPromptDeps.write(char);
  return buffer + char;
}

/**
 * `onEmptySubmit` turns Enter-on-an-empty-buffer into an action rather than a
 * submission. An empty answer is meaningless for the prompts that use it (a
 * pasted auth code), and spending the keystroke here keeps the whole login on a
 * single stdin reader.
 */
function read(message: string, echo: boolean, onEmptySubmit: (() => void) | undefined, style: TerminalStyle) {
  const stdin = stdinOf();
  if (stdin.isTTY !== true) return Promise.reject(new PromptCancelledError());
  _terminalPromptDeps.write(`${style.accent("?")} ${message} `);

  return new Promise<string>((resolve, reject) => {
    let buffer = "";
    let settled = false;

    const cleanup = (): void => {
      if (settled) return;
      settled = true;
      stdin.removeListener("data", onData);
      stdin.removeListener("end", onEnd);
      stdin.removeListener("error", onEnd);
      stdin.setRawMode(false);
      stdin.pause();
      _terminalPromptDeps.write("\n");
    };

    const onEnd = (): void => {
      cleanup();
      reject(new PromptCancelledError());
    };

    const onData = (chunk: string): void => {
      for (const char of chunk) {
        const action = keyAction(char, buffer.length === 0, onEmptySubmit !== undefined);
        if (action.kind === "cancel") {
          onEnd();
          return;
        }
        if (action.kind === "submit") {
          cleanup();
          resolve(buffer);
          return;
        }
        buffer = applyEdit(action, char, buffer, echo, onEmptySubmit);
      }
    };

    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    stdin.on("data", onData);
    stdin.once("end", onEnd);
    stdin.once("error", onEnd);
  });
}

/** Reads a secret. Nothing is echoed, not even a masking character. */
export function promptForSecret(message: string, style: TerminalStyle = PLAIN_STYLE): Promise<string> {
  return read(message, false, undefined, style);
}

/** Reads a visible line, for non-secret answers such as a pasted auth code. */
export function promptForLine(
  message: string,
  onEmptySubmit?: () => void,
  style: TerminalStyle = PLAIN_STYLE,
): Promise<string> {
  return read(message, true, onEmptySubmit, style);
}

export interface SelectChoice {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
}

/** Rows drawn at once. A longer list is narrowed by typing, never printed whole. */
const MAX_VISIBLE_ROWS = 12;

/** Case-insensitive label match; an empty filter matches everything. */
function matchedRows(choices: readonly SelectChoice[], filter: string): SelectChoice[] {
  const needle = filter.toLowerCase();
  return needle === "" ? [...choices] : choices.filter((c) => c.label.toLowerCase().includes(needle));
}

/** The first row index the window must show so that `active` is visible. */
function windowStart(active: number, total: number): number {
  return Math.min(active, Math.max(0, total - MAX_VISIBLE_ROWS));
}

interface SelectRun {
  readonly choices: readonly SelectChoice[];
  readonly style: TerminalStyle;
  readonly stdin: PromptStdin;
  readonly resolve: (id: string) => void;
  readonly reject: () => void;
  filter: string;
  active: number;
  drawn: number;
  settled: boolean;
  onData: (chunk: string) => void;
  onEnd: () => void;
}

function drawSelectLine(run: SelectRun, text: string): void {
  _terminalPromptDeps.write(`\r\u001b[2K${text}\n`);
  run.drawn += 1;
}

function drawSelectRow(run: SelectRun, choice: SelectChoice, isActive: boolean): void {
  const marker = isActive ? run.style.accent(">") : " ";
  const label = isActive ? run.style.accent(choice.label) : choice.label;
  const note = isActive && choice.description !== undefined ? ` ${run.style.dim(choice.description)}` : "";
  drawSelectLine(run, `${marker} ${label}${note}`);
}

function renderSelect(run: SelectRun): void {
  const rows = matchedRows(run.choices, run.filter);
  if (run.active >= rows.length) run.active = 0;
  const start = windowStart(run.active, rows.length);
  if (run.drawn > 0) _terminalPromptDeps.write(`\u001b[${run.drawn}A`);
  run.drawn = 0;
  drawSelectLine(run, run.style.dim(run.filter));
  for (const [i, choice] of rows.slice(start, start + MAX_VISIBLE_ROWS).entries()) {
    drawSelectRow(run, choice, start + i === run.active);
  }
}

function moveSelect(run: SelectRun, delta: number): void {
  const rows = matchedRows(run.choices, run.filter);
  if (rows.length > 0) run.active = (run.active + delta + rows.length) % rows.length;
  renderSelect(run);
}

function cleanupSelect(run: SelectRun): void {
  if (run.settled) return;
  run.settled = true;
  run.stdin.removeListener("data", run.onData);
  run.stdin.removeListener("end", run.onEnd);
  run.stdin.removeListener("error", run.onEnd);
  run.stdin.setRawMode(false);
  run.stdin.pause();
}

function endSelect(run: SelectRun): void {
  cleanupSelect(run);
  run.reject();
}

function handleSelectKey(run: SelectRun, chunk: string): void {
  // Whole-chunk matching: an arrow key is a three-byte escape sequence.
  if (chunk.includes(ETX) || chunk.includes(EOT)) {
    endSelect(run);
    return;
  }
  if (chunk.includes(ARROW_UP)) {
    moveSelect(run, -1);
    return;
  }
  if (chunk.includes(ARROW_DOWN)) {
    moveSelect(run, 1);
    return;
  }
  if (chunk.includes(CR) || chunk.includes(LF)) {
    const rows = matchedRows(run.choices, run.filter);
    if (rows.length === 0) return;
    cleanupSelect(run);
    // biome-ignore lint/style/noNonNullAssertion: active is held below rows.length by renderSelect and the guard above.
    run.resolve(rows[run.active]!.id);
    return;
  }
  run.filter = chunk.includes(BACKSPACE) ? run.filter.slice(0, -1) : run.filter + chunk;
  run.active = 0;
  renderSelect(run);
}

/**
 * Reads a choice with the arrow keys and returns the chosen option's id. The
 * option block is redrawn in place, so a value that is not an option can never
 * be returned. Typed characters narrow the block rather than answering it: a
 * catalog-sized list is scrolled by filtering, not printed whole, and the redraw
 * moves up only by the rows it drew — a block taller than the terminal cannot be
 * repainted, because the cursor-up cannot cross the scrollback. Enter with no
 * match commits nothing.
 */
export function promptForSelect(
  message: string,
  choices: readonly SelectChoice[],
  style: TerminalStyle = PLAIN_STYLE,
): Promise<string> {
  const stdin = stdinOf();
  if (stdin.isTTY !== true) return Promise.reject(new PromptCancelledError());
  // Never silently pick for the user: an empty list is a caller bug.
  if (choices.length === 0) return Promise.reject(new PromptCancelledError());

  _terminalPromptDeps.write(`${style.accent("?")} ${message}\n`);

  return new Promise<string>((resolve, reject) => {
    const run: SelectRun = {
      choices,
      style,
      stdin,
      resolve,
      reject: () => reject(new PromptCancelledError()),
      onData: (chunk) => handleSelectKey(run, chunk),
      onEnd: () => endSelect(run),
      filter: "",
      active: 0,
      drawn: 0,
      settled: false,
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    stdin.on("data", run.onData);
    stdin.once("end", run.onEnd);
    stdin.once("error", run.onEnd);
    renderSelect(run);
  });
}
