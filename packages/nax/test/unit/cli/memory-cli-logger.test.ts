/**
 * US-006 — what `cliMemoryLogger` writes to the terminal.
 *
 * The logger the `nax memory` group hands its host renders a warning as one
 * stderr line. A repo note that was skipped used to print as `[memory] repo note
 * skipped` with no file and no reason, so the operator had nothing to act on. The
 * data object the host passes is now rendered after the message as `key=value`
 * pairs, in the object's own key order.
 *
 * The rendering rules pinned here, one case each: a string is used as is, a number
 * or boolean goes through `String`, anything else through `JSON.stringify`, an
 * absent or empty object adds nothing at all, and a line break inside a value
 * becomes one space so the value cannot forge a second stderr line.
 *
 * The deps seam is the one `memory.test.ts` drives: only `logErr` matters to a
 * logger, everything else is stubbed so nothing is read and nothing is spawned.
 */

import { describe, expect, test } from "bun:test";
import { makeNaxConfig } from "@test/helpers";
import { cliMemoryLogger, type MemoryCliDeps } from "@/cli";

interface LoggerHarness {
  /** The logger over the stubbed deps. */
  readonly logger: ReturnType<typeof cliMemoryLogger>;
  /** Every line handed to `logErr`, in order. */
  readonly err: string[];
  /** Every line handed to `log`, in order — a warning must never land here. */
  readonly out: string[];
}

/** `cliMemoryLogger` over a deps double that keeps both output channels. */
function harness(): LoggerHarness {
  const err: string[] = [];
  const out: string[] = [];
  const deps: MemoryCliDeps = {
    log: (msg) => out.push(msg),
    logErr: (msg) => err.push(msg),
    exit: () => {},
    findProjectDir: () => null,
    loadConfig: async () => makeNaxConfig(),
    createMemoryHost: async () => null,
    readFile: async () => "",
  };
  return { logger: cliMemoryLogger(deps), err, out };
}

describe("cliMemoryLogger — warn and error data", () => {
  test("AC-1 renders a two-field data object after the message", () => {
    const h = harness();

    h.logger.warn("memory", "repo note skipped", {
      path: "/r/.nax/memory/a.md",
      reason: "invalid note: x",
    });

    expect(h.err).toEqual(["[memory] repo note skipped: path=/r/.nax/memory/a.md reason=invalid note: x"]);
  });

  test("AC-2 adds no suffix for a call that passes no data", () => {
    const h = harness();

    h.logger.warn("memory", "m");

    expect(h.err).toEqual(["[memory] m"]);
  });

  test("AC-3 adds no suffix for an empty data object", () => {
    const h = harness();

    h.logger.warn("memory", "m", {});

    expect(h.err).toEqual(["[memory] m"]);
  });

  test("AC-4 renders scalars through String and anything else through JSON.stringify", () => {
    const h = harness();

    h.logger.warn("memory", "m", { skipped: 3, ok: false, list: ["a"] });

    expect(h.err).toEqual([`[memory] m: skipped=3 ok=false list=["a"]`]);
  });

  test("AC-5 flattens an actual LF line break inside a value to one space", () => {
    const h = harness();
    // Built at runtime so the break is one LF CHARACTER, not the two characters
    // `\` and `n` that a value could legitimately carry.
    const reason = ["one", "two"].join("\n");
    expect(reason).toHaveLength(7);

    h.logger.error("memory", "m", { reason });

    expect(h.err).toEqual(["[memory] m: reason=one two"]);
  });
});

describe("cliMemoryLogger — every line break, and every other channel", () => {
  test("flattens a CRLF and a bare CR the same way as an LF", () => {
    const h = harness();

    h.logger.warn("memory", "m", { crlf: "a\r\nb", cr: "c\rd" });

    expect(h.err).toEqual(["[memory] m: crlf=a b cr=c d"]);
  });

  test("keeps the data object's own key order", () => {
    const h = harness();

    h.logger.warn("memory", "m", { scope: "project", slug: "s", reason: "r" });

    expect(h.err).toEqual(["[memory] m: scope=project slug=s reason=r"]);
  });

  test("drops info and debug, on both channels", () => {
    const h = harness();

    h.logger.info("memory", "sync started", { pushed: 2 });
    h.logger.debug("memory", "store opened", { providerId: "local" });

    expect(h.err).toEqual([]);
    expect(h.out).toEqual([]);
  });

  test("writes a warning to stderr only, never to command stdout", () => {
    const h = harness();

    h.logger.warn("memory", "repo note skipped", { path: "/r/.nax/memory/a.md" });

    expect(h.out).toEqual([]);
    expect(h.err).toHaveLength(1);
  });
});
