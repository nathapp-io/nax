/**
 * Deterministic classifier for acceptance-test crashes.
 *
 * A run that exits non-zero with no `AC-N`-tagged failure is either
 * `expected-red` (the acceptance file references a symbol the feature has not
 * created yet — the RED gate should see it) or `repairable` (anything else,
 * including a broken load the acceptance-repair op can fix).
 *
 * Scope: only Go and Rust compiler output is recognised; every other language
 * (including `undefined`) classifies as `repairable`, because their missing
 * symbols also surface as load failures the repair op can still attempt.
 */

export type AcceptanceCrashClass = "expected-red" | "repairable";

/** A Go compiler error line: `<path>.go:<line>[:<col>]: <message>`. */
const GO_ERROR_LINE = /([^\s:]+\.go):\d+(?::\d+)?:\s*(.*)$/;

/** A Go message for a symbol the feature has not created yet. */
function isGoMissingSymbol(message: string): boolean {
  const msg = message.trim();
  if (msg.startsWith("undefined: ")) return true;
  // e.g. `cfg.Parse undefined (type *Config has no field or method Parse)`
  return / undefined \(type .+ has no field or method .+\)$/.test(msg);
}

function classifyGo(output: string): AcceptanceCrashClass {
  const messages: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = GO_ERROR_LINE.exec(line);
    if (match) messages.push(match[2]);
  }
  if (messages.length === 0) return "repairable";
  return messages.every(isGoMissingSymbol) ? "expected-red" : "repairable";
}

/** A Rust coded error line: `error[E<4 digits>]: ...`. */
const RUST_CODED_ERROR = /^error\[(E\d{4})\]/;
/** An uncoded Rust error line: `error: ...`. */
const RUST_UNCODED_ERROR = /^error:/;
/** Summary forms that carry no diagnostic of their own. */
const RUST_SUMMARY_ERROR = /^error: (?:could not compile|aborting due to)/;

/** Codes that mark a reference to a symbol the feature has not created yet. */
const RUST_MISSING_SYMBOL_CODES = new Set(["E0425", "E0432", "E0433", "E0412", "E0599"]);

function classifyRust(output: string): AcceptanceCrashClass {
  const codes: string[] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    const coded = RUST_CODED_ERROR.exec(line);
    if (coded) {
      codes.push(coded[1]);
      continue;
    }
    if (!RUST_UNCODED_ERROR.test(line)) continue;
    if (RUST_SUMMARY_ERROR.test(line)) continue;
    // An uncoded, non-summary error line is a syntax error — repairable.
    return "repairable";
  }
  if (codes.length === 0) return "repairable";
  return codes.every((code) => RUST_MISSING_SYMBOL_CODES.has(code)) ? "expected-red" : "repairable";
}

/**
 * Classify the compiler output of an acceptance run that exited non-zero with
 * no `AC-N`-tagged failure. `language` is matched case-insensitively; anything
 * unrecognised (including `undefined`) is `repairable`.
 */
export function classifyAcceptanceCrash(output: string, language: string | undefined): AcceptanceCrashClass {
  switch (language?.toLowerCase()) {
    case "go":
      return classifyGo(output);
    case "rust":
      return classifyRust(output);
    default:
      return "repairable";
  }
}
