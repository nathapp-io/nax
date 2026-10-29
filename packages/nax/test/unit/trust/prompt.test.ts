import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { loadTrustModule } from "@test/helpers";
import { readStdinLine } from "@/trust/prompt";

const trust = await loadTrustModule();
let originalAsk: typeof trust._trustPromptDeps.ask | undefined;

beforeEach(() => {
  expect(typeof trust._trustPromptDeps).toBe("object");
  originalAsk = trust._trustPromptDeps.ask;
});

afterEach(() => {
  if (originalAsk) trust._trustPromptDeps.ask = originalAsk;
});

describe("promptTrustChoice", () => {
  test("US-002 AC14: treats a trimmed uppercase Y as yes", async () => {
    trust._trustPromptDeps.ask = async () => "Y";

    await expect(trust.promptTrustChoice("/r/p", "/r")).resolves.toBe("yes");
  });

  test("US-002 AC15: treats a trimmed parent answer as parent", async () => {
    trust._trustPromptDeps.ask = async () => " parent ";

    await expect(trust.promptTrustChoice("/r/p", "/r")).resolves.toBe("parent");
  });

  test("US-002 AC16: treats an empty answer as no", async () => {
    trust._trustPromptDeps.ask = async () => "";

    await expect(trust.promptTrustChoice("/r/p", "/r")).resolves.toBe("no");
  });

  test("US-002 AC17: treats end of input as no", async () => {
    trust._trustPromptDeps.ask = async () => null;

    await expect(trust.promptTrustChoice("/r/p", "/r")).resolves.toBe("no");
  });

  test("US-002 AC18: asks the exact question when a parent can be trusted", async () => {
    let asked: string | undefined;
    trust._trustPromptDeps.ask = async (question) => {
      asked = question;
      return "no";
    };

    await trust.promptTrustChoice("/r/p", "/r");

    expect(asked).toBe(
      "Trust /r/p? nax will run this project's plugins, hooks, MCP servers and test commands. [y]es / [p]arent (/r) / [N]o ",
    );
  });

  test("US-002 AC19: refuses the parent choice when no parent was offered", async () => {
    trust._trustPromptDeps.ask = async () => "p";

    await expect(trust.promptTrustChoice("/r/p", null)).resolves.toBe("no");
  });

  test("US-002 AC20: asks the exact question without a parent choice", async () => {
    let asked: string | undefined;
    trust._trustPromptDeps.ask = async (question) => {
      asked = question;
      return "no";
    };

    await trust.promptTrustChoice("/home/u/p", null);

    expect(asked).toBe(
      "Trust /home/u/p? nax will run this project's plugins, hooks, MCP servers and test commands. [y]es / [N]o ",
    );
  });
});

const PROMPT_MODULE = new URL("../../../src/trust/prompt.ts", import.meta.url).pathname;

/**
 * Run the real prompt in a child bun with `input` piped to stdin, then read what
 * is left of stdin the way Ink does (a `readable` listener). A child process is
 * the only faithful harness: the bug (#2733) lives in what the first reader
 * leaves behind on the process-wide stdin stream.
 */
async function runPromptThenReadStdin(input: string) {
  const script = `
    import { promptTrustChoice } from ${JSON.stringify(PROMPT_MODULE)};
    const choice = await promptTrustChoice("/r/p", "/r");
    let rest = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("readable", () => {
      for (let chunk = process.stdin.read(); chunk !== null; chunk = process.stdin.read()) rest += chunk;
    });
    const report = () => {
      console.log(JSON.stringify({ choice, rest }));
      process.exit(0);
    };
    // The prompt may itself have consumed end of input.
    if (process.stdin.readableEnded) report();
    process.stdin.on("end", report);
  `;
  const proc = Bun.spawn(["bun", "-e", script], {
    stdin: new Response(input),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  const parsed: { choice: string; rest: string } = JSON.parse(stdout);
  return { ...parsed, stderr };
}

describe("production trust prompt input", () => {
  test.each([
    ["CRLF answer", "Y\r\n", "yes"],
    ["answer followed by more input", "parent\nignored", "parent"],
    ["answer without a newline", "yes", "yes"],
    ["end of input", "", "no"],
  ] as const)("reads %s and writes the question only to stderr", async (_name, input, choice) => {
    const result = await runPromptThenReadStdin(input);

    expect(result.choice).toBe(choice);
    expect(result.stderr).toBe(
      "Trust /r/p? nax will run this project's plugins, hooks, MCP servers and test commands. [y]es / [p]arent (/r) / [N]o ",
    );
  });

  test("#2733: leaves stdin readable for the reader that follows the prompt", async () => {
    const result = await runPromptThenReadStdin("y\nhello\n");

    expect(result.choice).toBe("yes");
    expect(result.rest).toBe("hello\n");
  });
});

describe("readStdinLine", () => {
  test("joins a line split across writes and pushes back the input after it", async () => {
    const stdin = new PassThrough();
    const line = readStdinLine(stdin);
    stdin.write("pa");
    await Promise.resolve();
    stdin.write("rent\r");
    await Promise.resolve();
    stdin.write("\nhello\n");

    await expect(line).resolves.toBe("parent");
    expect(String(stdin.read())).toBe("hello\n");
    expect(stdin.listenerCount("readable")).toBe(0);
    expect(stdin.listenerCount("end")).toBe(0);
  });

  test("resolves null for a stream that has already ended", async () => {
    const stdin = new PassThrough();
    stdin.end();
    stdin.read();
    await new Promise((resolve) => stdin.once("end", resolve));

    await expect(readStdinLine(stdin)).resolves.toBeNull();
  });
});
