/**
 * US-002: one task source (`--task` / `--task-file`), an injected reader, the empty-task check and
 * leading `/skill <args>` expansion with the chat's own builder. Catalog commands are not expanded.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { assertNaxError, cleanupTempDir, makeTempDir } from "@test/helpers";
import { resolveAgentsRunTask } from "@/cli/agents-run-task";
import type { NaxError } from "@/errors";
import { buildSkillInvocationMessage } from "@/prompts";
import type { ResourceCatalog, SkillResource } from "@/resources";

const CWD = "/repo";

const specReview: SkillResource = {
  kind: "skill",
  name: "spec-review",
  qualifiedName: "spec-review",
  description: "Review a spec",
  body: "Review the spec at the path you are given.",
  baseDir: "/skills/spec-review",
  path: "/skills/spec-review/SKILL.md",
  modelInvocable: true,
  origin: { kind: "claude-project" },
};

/** A plugin-qualified skill: the name contains a colon, so the task is `/nax-spec-kit:spec-review`. */
const qualifiedSpecReview: SkillResource = {
  ...specReview,
  qualifiedName: "nax-spec-kit:spec-review",
  name: "spec-review",
  baseDir: "/skills/nax-spec-kit/spec-review",
  path: "/skills/nax-spec-kit/spec-review/SKILL.md",
  origin: { kind: "nax-plugin", plugin: "nax-spec-kit" },
};

/** A catalog stub that records every lookup, so "never called" is assertable. */
function makeCatalog(skills: readonly SkillResource[] = [specReview]): {
  catalog: Pick<ResourceCatalog, "findSkill">;
  asked: string[];
} {
  const asked: string[] = [];
  return {
    asked,
    catalog: {
      findSkill(name: string) {
        asked.push(name);
        return skills.find((skill) => skill.qualifiedName === name) ?? skills.find((skill) => skill.name === name);
      },
    },
  };
}

/** A reader stub that records the path it was handed. */
function makeReader(text: string): { readText: (path: string) => Promise<string>; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    readText(path: string) {
      calls.push(path);
      return Promise.resolve(text);
    },
  };
}

/** Await a rejection and narrow it to `NaxError`, failing with what was actually resolved/thrown. */
async function rejection(promise: Promise<unknown>): Promise<NaxError> {
  try {
    const resolved = await promise;
    throw new Error(`expected a rejection, resolved to ${JSON.stringify(resolved)}`);
  } catch (err) {
    assertNaxError(err, "resolveAgentsRunTask rejection");
    return err;
  }
}

describe("resolveAgentsRunTask", () => {
  describe("source selection", () => {
    test("AC-1: resolves an inline --task unchanged", async () => {
      const { catalog } = makeCatalog();
      expect(await resolveAgentsRunTask({ task: "review the spec", cwd: CWD, catalog })).toBe("review the spec");
    });

    test("AC-2: rejects when neither source is given", async () => {
      const { catalog } = makeCatalog();
      const err = await rejection(resolveAgentsRunTask({ cwd: CWD, catalog }));
      expect(err.code).toBe("AGENTS_RUN_USAGE");
      expect(err.message).toBe("pass exactly one of --task or --task-file");
    });

    test("AC-3: rejects when both sources are given", async () => {
      const { catalog } = makeCatalog();
      const err = await rejection(resolveAgentsRunTask({ task: "x", taskFile: "task.md", cwd: CWD, catalog }));
      expect(err.code).toBe("AGENTS_RUN_USAGE");
      expect(err.message).toBe("pass exactly one of --task or --task-file");
    });
  });

  describe("task file", () => {
    let tempDir: string | undefined;
    afterEach(() => {
      cleanupTempDir(tempDir);
      tempDir = undefined;
    });

    test("AC-4: resolves a relative --task-file against cwd and returns the read text", async () => {
      const { catalog } = makeCatalog();
      const { readText, calls } = makeReader("from the file");
      const message = await resolveAgentsRunTask({ taskFile: "task.md", cwd: CWD, catalog }, { readText });
      expect(calls).toEqual(["/repo/task.md"]);
      expect(message).toBe("from the file");
    });

    test("AC-5: reads an absolute --task-file as given", async () => {
      const { catalog } = makeCatalog();
      const { readText, calls } = makeReader("from the file");
      await resolveAgentsRunTask({ taskFile: "/abs/task.md", cwd: CWD, catalog }, { readText });
      expect(calls).toEqual(["/abs/task.md"]);
    });

    test("AC-6: reports an unreadable task file with the CLI-supplied path", async () => {
      const { catalog } = makeCatalog();
      const err = await rejection(
        resolveAgentsRunTask(
          { taskFile: "task.md", cwd: CWD, catalog },
          { readText: () => Promise.reject(new Error("ENOENT")) },
        ),
      );
      expect(err.code).toBe("AGENTS_RUN_USAGE");
      expect(err.message).toBe("cannot read task file task.md: ENOENT");
    });

    test("AC-7: the default reader reads the file from disk", async () => {
      tempDir = makeTempDir("nax-agents-run-task-");
      await Bun.write(join(tempDir, "task.md"), "read the spec\n");
      const { catalog } = makeCatalog();
      expect(await resolveAgentsRunTask({ taskFile: "task.md", cwd: tempDir, catalog })).toBe("read the spec\n");
    });

    test("rejects an empty task file", async () => {
      const { catalog } = makeCatalog();
      const err = await rejection(
        resolveAgentsRunTask({ taskFile: "task.md", cwd: CWD, catalog }, { readText: () => Promise.resolve("  \n") }),
      );
      expect(err.code).toBe("AGENTS_RUN_USAGE");
      expect(err.message).toBe("the task is empty");
    });
  });

  describe("empty task", () => {
    test("AC-8: rejects a whitespace-only --task", async () => {
      const { catalog } = makeCatalog();
      const err = await rejection(resolveAgentsRunTask({ task: "   ", cwd: CWD, catalog }));
      expect(err.code).toBe("AGENTS_RUN_USAGE");
      expect(err.message).toBe("the task is empty");
    });
  });

  describe("skill expansion", () => {
    test("AC-9: expands a leading skill name into the invocation message with its arguments", async () => {
      const { catalog } = makeCatalog();
      const message = await resolveAgentsRunTask({
        task: "/spec-review .nax/features/x/spec.md",
        cwd: CWD,
        catalog,
      });
      expect(message).toBe(buildSkillInvocationMessage({ skill: specReview, args: ".nax/features/x/spec.md" }));
    });

    test("AC-10: a qualified skill name with no arguments expands with empty args", async () => {
      const { catalog, asked } = makeCatalog([qualifiedSpecReview]);
      const message = await resolveAgentsRunTask({ task: "/nax-spec-kit:spec-review", cwd: CWD, catalog });
      expect(asked).toEqual(["nax-spec-kit:spec-review"]);
      expect(message).toBe(buildSkillInvocationMessage({ skill: qualifiedSpecReview, args: "" }));
    });

    test("AC-11: surrounding and inner whitespace are trimmed before the lookup and the args", async () => {
      const { catalog, asked } = makeCatalog();
      const message = await resolveAgentsRunTask({ task: "  /spec-review   a.md  ", cwd: CWD, catalog });
      expect(asked).toEqual(["spec-review"]);
      expect(message).toBe(buildSkillInvocationMessage({ skill: specReview, args: "a.md" }));
    });

    test("AC-12: rejects a skill name no skill answers to", async () => {
      const { catalog } = makeCatalog([]);
      const err = await rejection(resolveAgentsRunTask({ task: "/nope a.md", cwd: CWD, catalog }));
      expect(err.code).toBe("AGENTS_RUN_USAGE");
      expect(err.message).toBe("skill nope not found");
    });

    test("AC-13: a slash that is not first is not an invocation", async () => {
      const { catalog, asked } = makeCatalog();
      const message = await resolveAgentsRunTask({ task: "review /spec-review a.md", cwd: CWD, catalog });
      expect(message).toBe("review /spec-review a.md");
      expect(asked).toEqual([]);
    });

    test("AC-14: a bare slash is not an invocation", async () => {
      const { catalog, asked } = makeCatalog();
      const message = await resolveAgentsRunTask({ task: "/", cwd: CWD, catalog });
      expect(message).toBe("/");
      expect(asked).toEqual([]);
    });
  });
});
