import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir, waitForAsyncCondition as until } from "@test/helpers";

const TMUX = Bun.which("tmux");
const FIXTURE = join(import.meta.dir, "../../../fixtures/chat-pty/host.ts");
/**
 * How long a resize case waits for the screen to settle. The mount repaints
 * `RESIZE_REPAINT_MS` after the last resize, and a loaded runner can draw the widened frame
 * well after the narrowed one, so the helper's eight-second default is not enough headroom for
 * a comparison that has to hold once and for all.
 */
const SETTLE_MS = 20_000;

function tmux(socket: string, ...args: string[]): string {
  const result = Bun.spawnSync([TMUX ?? "tmux", "-S", socket, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 2_000,
  });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout);
}

/** Binary presence is insufficient: the sandbox must permit both sockets and PTYs. */
function capability(): string | undefined {
  if (!TMUX) return "tmux is not installed";
  const dir = makeTempDir("p-");
  const socket = join(dir, "tmux.sock");
  try {
    tmux(socket, "-f", "/dev/null", "new-session", "-d", "-s", "probe", "-x", "80", "-y", "24", "sleep 30");
    tmux(socket, "has-session", "-t", "probe");
    return undefined;
  } catch (error) {
    return `tmux PTY/socket unavailable: ${String(error)}`;
  } finally {
    Bun.spawnSync([TMUX, "-S", socket, "kill-server"], { stdout: "pipe", stderr: "pipe", timeout: 2_000 });
    cleanupTempDir(dir);
  }
}

function disposeOwnedServer(socket: string, dir: string): void {
  Bun.spawnSync([TMUX ?? "tmux", "-S", socket, "kill-server"], { stdout: "pipe", stderr: "pipe", timeout: 2_000 });
  const probe = Bun.spawnSync([TMUX ?? "tmux", "-S", socket, "has-session"], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 2_000,
  });
  expect(probe.exitCode).not.toBe(0);
  cleanupTempDir(dir);
  expect(existsSync(dir)).toBe(false);
}

const skip = capability();
if (skip) console.info(`SKIP chat layout real PTY: ${skip}`);

describe("source renderChat physical resize", () => {
  test.skipIf(Boolean(skip))(
    "AC-33 a failing source fixture is cleaned through the same ownership boundary",
    async () => {
      const dir = makeTempDir("p-");
      const socket = join(dir, "tmux.sock");
      const control = join(dir, "control.sock");
      await expect(
        (async () => {
          try {
            const command = `CI=0 CONTINUOUS_INTEGRATION=0 ${JSON.stringify(process.execPath)} ${JSON.stringify(FIXTURE)} ${JSON.stringify(control)}`;
            tmux(socket, "-f", "/dev/null", "new-session", "-d", "-s", "chat", "-x", "80", "-y", "24", command);
            await until(async () => existsSync(control), Boolean);
            throw new Error("test-owned failure");
          } finally {
            disposeOwnedServer(socket, dir);
          }
        })(),
      ).rejects.toThrow("test-owned failure");
    },
  );
  test.skipIf(Boolean(skip)).each(["queue", "steers", "diagnostic"] as const)(
    "AC-24..30 complete %s frame survives resize, ticks and idle",
    async (scenario) => {
      const dir = makeTempDir("p-");
      const socket = join(dir, "tmux.sock");
      const control = join(dir, "control.sock");
      const referenceControl = join(dir, "reference.sock");
      const call = async (path = "/state", reference = false) => {
        const response = await fetch(`http://localhost${path}`, {
          unix: reference ? referenceControl : control,
          signal: AbortSignal.timeout(1_000),
        });
        return response.text();
      };
      const capture = async (reference = false) =>
        tmux(socket, "capture-pane", "-p", "-t", reference ? "reference:0.0" : "chat:0.0").trimEnd();
      const current = () => capture();
      const key = (text: string) => {
        for (const target of ["chat", "reference"]) tmux(socket, "send-keys", "-t", `${target}:0.0`, text);
      };
      const type = (text: string) => {
        for (const target of ["chat", "reference"]) tmux(socket, "send-keys", "-t", `${target}:0.0`, "-l", text);
      };
      /**
       * Type a line, and hold the key that submits it until both panes have drawn the draft.
       *
       * `send-keys` writes the literal text and the following key as separate pty writes, but
       * two writes are not two reads: an app that has not drained stdin yet — a freshly mounted
       * one, on a loaded runner — reads both in the same chunk, and ink hands a chunk to its
       * handlers as text (`parseKeypress` only calls a lone `\r` a return), so the submit key
       * inside it is never a submit. The line then sits in the prompt forever and nothing is
       * sent (#2965). The drawn draft is proof the text was read, so the key that follows
       * arrives as a chunk of its own.
       */
      const compose = async (text: string): Promise<void> => {
        type(text);
        for (const reference of [false, true])
          await until(
            () => capture(reference),
            (frame) => frame.includes(text),
          );
      };
      try {
        const command = `CI=0 CONTINUOUS_INTEGRATION=0 FORCE_COLOR=0 ${JSON.stringify(process.execPath)} ${JSON.stringify(FIXTURE)} ${JSON.stringify(control)}`;
        tmux(
          socket,
          "-f",
          "/dev/null",
          "new-session",
          "-d",
          "-s",
          "chat",
          "-x",
          "80",
          "-y",
          "24",
          `${command}; read test_done`,
        );
        tmux(
          socket,
          "new-session",
          "-d",
          "-s",
          "reference",
          "-x",
          "80",
          "-y",
          "24",
          `${command.replace(control, referenceControl)}; read test_done`,
        );
        await until(
          async () => ({ ready: existsSync(control) && existsSync(referenceControl), screen: await capture() }),
          (value) => value.ready,
        );
        for (const reference of [false, true])
          await until(
            () => capture(reference),
            (frame) => frame.includes("Try"),
          );
        await compose("hello");
        key("Enter");
        for (const reference of [false, true]) {
          await until(
            () => call("/state", reference),
            (state) => JSON.parse(state).sends === 1,
          );
          await until(
            () => capture(reference),
            (frame) => frame.includes("Writing"),
          );
        }
        // US-001 AC-21: with the turn running, a chat pane narrowed to 50 columns and then
        // widened again draws the frame the never-resized reference pane still shows, at the
        // 80 columns tmux reports. tmux may not re-wrap the alternate screen when it narrows,
        // so this case guards the width path; `ink-incremental-render.test.tsx` is the proof
        // that a repaint writes every row. It runs while no draft is queued, so the compared
        // frame holds no pending preview rows — those are the queue's own resize-reactive
        // projection, and this case is about the frame the mount repaints.
        const agreed = () =>
          until(
            async () => ({ chat: await capture(), reference: await capture(true) }),
            (frame) => frame.chat === frame.reference,
            // A settled frame, not a race: the mount repaints RESIZE_REPAINT_MS after the last
            // resize, and a loaded runner may draw the widened frame after the narrowed one.
            SETTLE_MS,
          );
        const paneWidth = async () => tmux(socket, "display-message", "-p", "-t", "chat:0", "#{pane_width}").trimEnd();
        /** The size the screen under test has measured — not just what tmux reports. */
        const appColumns = async (): Promise<unknown> => JSON.parse(await call()).columns;
        const running = await agreed();
        expect(running.chat).toBe(running.reference);
        tmux(socket, "resize-window", "-t", "chat:0", "-x", "50", "-y", "24");
        expect(await until(paneWidth, (value) => value === "50")).toBe("50");
        expect(await until(appColumns, (value) => value === 50)).toBe(50);
        // The narrowed frame is drawn before the widening lands: two resizes, not one.
        expect(await until(capture, (frame) => frame !== running.chat, SETTLE_MS)).not.toBe(running.chat);
        tmux(socket, "resize-window", "-t", "chat:0", "-x", "80", "-y", "24");
        expect(await until(paneWidth, (value) => value === "80")).toBe("80");
        expect(await until(appColumns, (value) => value === 80)).toBe(80);
        expect((await agreed()).chat).toBe(running.chat);
        const addPending = async () => {
          const count = scenario === "steers" ? 17 : 4;
          for (let i = 0; i < count; i++) {
            await compose(`pending ${i}`);
            key(scenario === "steers" ? "C-s" : "Enter");
            for (const reference of [false, true]) {
              if (scenario === "steers")
                await until(
                  () => call("/state", reference),
                  (state) => JSON.parse(state).steers === i + 1,
                );
              await until(
                () => capture(reference),
                (frame) =>
                  frame.split("\n").includes(">") &&
                  frame.includes(
                    i < 4 ? `${scenario === "steers" ? "steering" : "queued"} · pending ${i}` : `+${i - 2} pending`,
                  ),
              );
            }
          }
        };
        await addPending();
        const expected = await until(
          () => capture(true),
          (frame) => frame === tmux(socket, "capture-pane", "-p", "-t", "chat:0.0").trimEnd(),
        );
        expect(expected.split("\n")[0]).toContain("nax");
        expect(expected.split("\n")).toHaveLength(23);
        const resizeAndAssert = async () => {
          for (const height of [12, ...(scenario === "diagnostic" ? [2] : []), 24]) {
            tmux(socket, "resize-window", "-t", "chat:0", "-x", "80", "-y", String(height));
            await until(
              () => call(),
              (state) => JSON.parse(state).rows === height,
            );
            await until(current, (frame) =>
              height === 24
                ? frame === expected
                : height === 2
                  ? frame.includes("Terminal too small")
                  : frame.includes("pending"),
            );
          }
        };
        await resizeAndAssert();
        for (let i = 0; i < 4; i++) {
          await call("/bytes");
          await call("/tick", true);
          await call("/tick");
          const phase = i % 2 ? "Writing" : "Thinking";
          await until(current, (frame) => frame.includes(phase));
          const bytes = await call("/bytes");
          expect(bytes).not.toContain("\x1b[2J");
          expect(bytes).not.toContain("\x1b[3J");
          const tickFrame = await until(
            () => capture(true),
            (frame) => frame.includes(phase),
          );
          expect(await until(current, (frame) => frame === tickFrame)).toBe(tickFrame);
        }
        await call("/idle", true);
        await call("/idle");
        const idle = await until(
          current,
          (frame) => !frame.includes("Writing") && !frame.includes("Thinking") && frame.includes("Try"),
        );
        const expectedIdle = await until(
          () => capture(true),
          (frame) => frame === idle,
        );
        expect(idle).toBe(expectedIdle);
        expect(idle.split("\n")[0]).toContain("nax");
        expect(idle.split("\n")).toHaveLength(23);
        expect(idle).not.toContain("pending ·");
        await call("/close", true);
        await call("/close");
      } finally {
        disposeOwnedServer(socket, dir);
      }
    },
    60_000,
  );
});
