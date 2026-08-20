import { describe, expect, test } from "bun:test";
import { resolveUseHeadless } from "@/cli/run-mode";

describe("resolveUseHeadless (BUG-23)", () => {
  test("TTY + normal formatter → TUI (not headless)", () => {
    expect(
      resolveUseHeadless({ isTTY: true, headlessFlag: false, headlessEnv: false, formatterMode: "normal" }),
    ).toBe(false);
  });

  test("non-TTY → headless regardless of formatter", () => {
    expect(
      resolveUseHeadless({ isTTY: false, headlessFlag: false, headlessEnv: false, formatterMode: "normal" }),
    ).toBe(true);
  });

  test("--headless flag forces headless on a TTY", () => {
    expect(resolveUseHeadless({ isTTY: true, headlessFlag: true, headlessEnv: false, formatterMode: "normal" })).toBe(
      true,
    );
  });

  test("NAX_HEADLESS env forces headless on a TTY", () => {
    expect(resolveUseHeadless({ isTTY: true, headlessFlag: false, headlessEnv: true, formatterMode: "normal" })).toBe(
      true,
    );
  });

  // BUG-23: --json on a TTY previously mounted the TUI and silently ignored --json.
  test("--json on a TTY forces headless so JSON output is actually emitted", () => {
    expect(resolveUseHeadless({ isTTY: true, headlessFlag: false, headlessEnv: false, formatterMode: "json" })).toBe(
      true,
    );
  });

  test("--json off a TTY is still headless (both reasons apply)", () => {
    expect(resolveUseHeadless({ isTTY: false, headlessFlag: false, headlessEnv: false, formatterMode: "json" })).toBe(
      true,
    );
  });

  test("verbose/quiet formatter on a TTY does not force headless", () => {
    expect(
      resolveUseHeadless({ isTTY: true, headlessFlag: false, headlessEnv: false, formatterMode: "verbose" }),
    ).toBe(false);
    expect(
      resolveUseHeadless({ isTTY: true, headlessFlag: false, headlessEnv: false, formatterMode: "quiet" }),
    ).toBe(false);
  });
});
