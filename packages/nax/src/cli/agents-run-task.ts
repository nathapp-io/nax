/**
 * US-002: resolve the one task source `nax agents run` was given, and expand a leading
 * `/skill <args>` invocation into that skill's message.
 *
 * Exactly one of `--task` / `--task-file` is required. A relative `--task-file` resolves
 * against `--dir`. Only skills expand, through the same builder the chat slash command uses
 * (`buildSkillInvocationMessage`); catalog commands — including their `` !`cmd` `` shell
 * lines — are never expanded here.
 */
import { isAbsolute, resolve } from "node:path";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { NaxError } from "@/errors";
import { buildSkillInvocationMessage } from "@/prompts";
import type { ResourceCatalog } from "@/resources";

export interface ResolveAgentsRunTaskInput {
  readonly task?: string;
  readonly taskFile?: string;
  /** `--dir`: the directory a relative `taskFile` resolves against. */
  readonly cwd: string;
  readonly catalog: Pick<ResourceCatalog, "findSkill">;
}

export interface ResolveAgentsRunTaskDeps {
  /** Overrides the default `Bun.file(path).text()` reader. */
  readonly readText?: (path: string) => Promise<string>;
}

const USAGE_ERROR_CODE = "AGENTS_RUN_USAGE";
const EXACTLY_ONE_TASK_SOURCE_MESSAGE = "pass exactly one of --task or --task-file";

/**
 * A leading `/name` whose name is one or more characters from `[A-Za-z0-9:_.-]`, followed by
 * whitespace or the end of the text. A bare `/`, an empty name, or a slash that is not first
 * is not an invocation.
 */
const SKILL_INVOCATION_PATTERN = /^\/([A-Za-z0-9:_.-]+)(?=\s|$)/;

const defaultReadText = (path: string): Promise<string> => Bun.file(path).text();

function usageError(message: string, context: Record<string, unknown> = {}): NaxError {
  return new NaxError(message, USAGE_ERROR_CODE, { stage: "agents-run", ...context });
}

/**
 * Exactly one source, or a usage error. `""` counts as given — it is an empty task, not an
 * absent one, so `--task ""` reports "the task is empty" rather than the source rule.
 */
async function resolveTaskText(input: ResolveAgentsRunTaskInput, deps: ResolveAgentsRunTaskDeps): Promise<string> {
  const { task, taskFile } = input;
  if (task !== undefined && taskFile !== undefined) throw usageError(EXACTLY_ONE_TASK_SOURCE_MESSAGE);
  if (task !== undefined) return task;
  if (taskFile === undefined) throw usageError(EXACTLY_ONE_TASK_SOURCE_MESSAGE);
  return readTaskFile(taskFile, input.cwd, deps.readText ?? defaultReadText);
}

/**
 * Read the task file at its resolved path. The failure message names the path the CLI was
 * given rather than the resolved one: that is the string the user typed and can correct.
 */
async function readTaskFile(
  taskFile: string,
  cwd: string,
  readText: (path: string) => Promise<string>,
): Promise<string> {
  const path = isAbsolute(taskFile) ? taskFile : resolve(cwd, taskFile);
  try {
    return await readText(path);
  } catch (err) {
    throw new NaxError(`cannot read task file ${taskFile}: ${errorMessage(err)}`, USAGE_ERROR_CODE, {
      stage: "agents-run",
      path,
      cause: err,
    });
  }
}

/**
 * The message to send to the agent: the task text unchanged, or — when it opens with a known
 * skill name — that skill's invocation message with the remaining text as its arguments.
 *
 * A task that does not match the invocation pattern is returned exactly as it arrived (a file's
 * trailing newline included), so only the skill case rewrites what the caller supplied.
 */
export async function resolveAgentsRunTask(
  input: ResolveAgentsRunTaskInput,
  deps: ResolveAgentsRunTaskDeps = {},
): Promise<string> {
  const text = await resolveTaskText(input, deps);
  const trimmed = text.trim();
  if (trimmed === "") throw usageError("the task is empty");

  const match = SKILL_INVOCATION_PATTERN.exec(trimmed);
  if (!match) return text;

  const name = match[1];
  const args = trimmed.slice(match[0].length).trim();
  const skill = input.catalog.findSkill(name);
  if (!skill) throw usageError(`skill ${name} not found`, { skill: name });
  return buildSkillInvocationMessage({ skill, args });
}
