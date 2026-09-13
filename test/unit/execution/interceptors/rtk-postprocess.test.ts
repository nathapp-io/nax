import { describe, expect, test } from "bun:test";
import { createRtkInterceptor } from "@/execution/interceptors/rtk";

const req = { kind: "argv" as const, argv: ["git", "log"], cwd: "/repo", site: "git" as const };
const present = { which: () => "/usr/bin/rtk", version: () => "0.45.0", record: () => {} };

/** Narrows `postProcess?` once, so no test needs a non-null assertion. */
function postProcess() {
  const { postProcess: fn } = createRtkInterceptor({
    enabled: true,
    verbs: ["log"],
    _deps: present,
  });
  if (fn === undefined) throw new Error("rtk interceptor must define postProcess");
  return fn;
}

describe("rtk postProcess", () => {
  test("strips a full-diff hint and the newline before it", () => {
    expect(postProcess()("diff body\n[full diff: rtk git diff --no-compact]", req).output).toBe("diff body");
  });

  test("strips a hidden-lines hint", () => {
    const { output } = postProcess()("body\n[+12 hidden: rtk recall 3f9c2a81d4e7]", req);
    expect(output).toBe("body");
    expect(output).not.toContain("rtk recall");
  });

  test("leaves output with no hints untouched", () => {
    expect(postProcess()("plain body", req).output).toBe("plain body");
  });

  test("does not eat trailing whitespace when there is no hint to strip", () => {
    // Stripping is hint-shaped, not a general trim: trimEnd happens later at
    // the call site, and postProcess must not pre-empt it.
    expect(postProcess()("plain body\n\n", req).output).toBe("plain body\n\n");
  });
});
