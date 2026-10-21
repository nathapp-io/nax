import { errorMessage } from "@nathapp/nax-agent/internal";
import { z } from "zod";
import { NaxError } from "@/errors";

export interface BotDecision {
  readonly id: string;
  readonly statement: string;
  readonly source?: string;
}

const MAX_FILE_BYTES = 262_144;
const MAX_DECISIONS = 100;
const MAX_STATEMENT_LENGTH = 2_000;
const MAX_SOURCE_LENGTH = 200;

export const _decisionsDeps = {
  fileSize: async (path: string): Promise<number> => (await Bun.file(path).stat()).size,
  readText: (path: string): Promise<string> => Bun.file(path).text(),
};

const DecisionsSchema = z.object({
  version: z.literal(1),
  decisions: z
    .array(
      z.object({
        id: z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/),
        statement: z.string().min(1).max(MAX_STATEMENT_LENGTH),
        source: z.string().max(MAX_SOURCE_LENGTH).optional(),
      }),
    )
    .max(MAX_DECISIONS)
    .superRefine((decisions, ctx) => {
      const ids = new Set<string>();
      for (const decision of decisions) {
        if (ids.has(decision.id)) {
          ctx.addIssue({ code: "custom", message: `duplicate id ${decision.id}` });
          return;
        }
        ids.add(decision.id);
      }
    }),
});

function invalidFile(path: string, problem: string, cause?: unknown): NaxError {
  return new NaxError(`[bot] Invalid decisions file ${path}: ${problem}`, "BOT_DECISIONS_INVALID", {
    stage: "bot",
    path,
    cause,
  });
}

function readFailed(path: string, cause: unknown): NaxError {
  return new NaxError(`[bot] Cannot read decisions file ${path}`, "BOT_DECISIONS_READ_FAILED", {
    stage: "bot",
    path,
    cause,
  });
}

async function readBoundedText(path: string): Promise<string> {
  let size: number;
  try {
    size = await _decisionsDeps.fileSize(path);
  } catch (cause) {
    throw readFailed(path, cause);
  }
  if (size > MAX_FILE_BYTES) throw invalidFile(path, `file exceeds ${MAX_FILE_BYTES} bytes`);
  try {
    return await _decisionsDeps.readText(path);
  } catch (cause) {
    throw readFailed(path, cause);
  }
}

export async function loadBotDecisions(path: string): Promise<BotDecision[]> {
  const text = await readBoundedText(path);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    throw invalidFile(path, errorMessage(cause), cause);
  }
  const result = DecisionsSchema.safeParse(raw);
  if (!result.success) {
    const first = result.error.issues[0];
    throw invalidFile(path, first ? first.message : result.error.message, result.error);
  }
  return result.data.decisions;
}
