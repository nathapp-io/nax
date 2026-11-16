type OutputStream = ReadableStream<Uint8Array> | number | undefined;
type OutputTarget = { write: (chunk: string) => unknown };

export type CapturedTestOutput = {
  stdout: string;
  stderr: string;
};

export type TestOutputController = {
  stdio: ["inherit", "inherit" | "pipe", "inherit" | "pipe"];
  collect: (stdout: OutputStream, stderr: OutputStream) => Promise<CapturedTestOutput>;
  finish: (output: CapturedTestOutput, abnormal: boolean) => void;
  /** Totalled bun `N pass` / `N fail` summary lines of the passing agent-mode phases. */
  summaryLines: () => string;
  /** The end-of-run banner, prefixed with `summaryLines()` when there is a total. */
  passedBanner: () => string;
};

/** Bun's own (non-verbose) summary lines, e.g. " 15 pass" / " 0 fail". */
const PASS_SUMMARY_LINE = /^\s*(\d+)\s+pass\s*$/gm;
const FAIL_SUMMARY_LINE = /^\s*(\d+)\s+fail\s*$/gm;

async function readOutput(stream: OutputStream): Promise<string> {
  return stream instanceof ReadableStream ? new Response(stream).text() : "";
}

/** The last `<count>` captured by `pattern` in `text`, or null when it never matched. */
function lastCount(text: string, pattern: RegExp): number | null {
  let value: number | null = null;
  for (const match of text.matchAll(pattern)) {
    value = Number.parseInt(match[1], 10);
  }
  return value;
}

/**
 * The bun pass/fail totals a single phase printed, or null when it printed no summary.
 *
 * stderr is preferred over stdout because that is where the wrapper's piped phase
 * summary lands; both counts come from the same stream so a phase can never be
 * totalled from one stream's pass line and the other's fail line. A pass line with
 * no fail line counts as zero failures — the pass line is the summary's anchor.
 */
function phaseTotals(output: CapturedTestOutput): { passed: number; failed: number } | null {
  for (const candidate of [output.stderr, output.stdout]) {
    const passed = lastCount(candidate, PASS_SUMMARY_LINE);
    if (passed !== null) {
      return { passed, failed: lastCount(candidate, FAIL_SUMMARY_LINE) ?? 0 };
    }
  }
  return null;
}

/** Capture successful agent runs quietly while retaining failure diagnostics. */
export function createTestOutputController(options: {
  agentMode: boolean;
  stdout: OutputTarget;
  stderr: OutputTarget;
}): TestOutputController {
  const { agentMode, stdout, stderr } = options;
  let passedTotal = 0;
  let failedTotal = 0;
  let phasesCounted = 0;

  const summaryLines = (): string => {
    // Verbose mode forwards every phase's own summary, so a total would be noise.
    if (!agentMode || phasesCounted === 0) return "";
    return ` ${passedTotal} pass\n ${failedTotal} fail\n`;
  };

  return {
    stdio: agentMode ? ["inherit", "pipe", "pipe"] : ["inherit", "inherit", "inherit"],
    collect: async (childStdout, childStderr) => {
      const [capturedStdout, capturedStderr] = await Promise.all([readOutput(childStdout), readOutput(childStderr)]);
      return { stdout: capturedStdout, stderr: capturedStderr };
    },
    finish: (output, abnormal) => {
      if (!agentMode) return;
      if (abnormal) {
        stdout.write(output.stdout);
        stderr.write(output.stderr);
        return;
      }
      const totals = phaseTotals(output);
      if (totals === null) return;
      passedTotal += totals.passed;
      failedTotal += totals.failed;
      phasesCounted += 1;
    },
    summaryLines,
    passedBanner: () => `${summaryLines()}\n[run-tests] all phases passed\n`,
  };
}
