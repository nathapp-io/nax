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
};

async function readOutput(stream: OutputStream): Promise<string> {
  return stream instanceof ReadableStream ? new Response(stream).text() : "";
}

/** Capture successful agent runs quietly while retaining failure diagnostics. */
export function createTestOutputController(options: {
  agentMode: boolean;
  stdout: OutputTarget;
  stderr: OutputTarget;
}): TestOutputController {
  const { agentMode, stdout, stderr } = options;
  return {
    stdio: agentMode ? ["inherit", "pipe", "pipe"] : ["inherit", "inherit", "inherit"],
    collect: async (childStdout, childStderr) => {
      const [capturedStdout, capturedStderr] = await Promise.all([readOutput(childStdout), readOutput(childStderr)]);
      return { stdout: capturedStdout, stderr: capturedStderr };
    },
    finish: (output, abnormal) => {
      if (!agentMode || !abnormal) return;
      stdout.write(output.stdout);
      stderr.write(output.stderr);
    },
  };
}
