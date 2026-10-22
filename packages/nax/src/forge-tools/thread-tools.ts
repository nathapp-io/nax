import type { ProviderTool } from "@nathapp/nax-agent";
import type { PrComment, PrRef, PrThread, WriterCheck } from "@/forge";
import { FORGE_COMMENT_CHARS, FORGE_MAX_THREADS } from "./constants";
import { _forgeToolsDeps } from "./deps";
import { fitToolResult } from "./fit-result";
import { wrapForgeTool } from "./tool";
import type { ForgeReadBinding } from "./types";

/** Shared with comment reads: authorize every comment before applying display caps. */
export async function writerComments(
  comments: readonly PrComment[],
  check: WriterCheck,
): Promise<{ comments: PrComment[]; withheld: number }> {
  const allowed = await Promise.all(comments.map((comment) => check({ login: comment.author, id: comment.authorId })));
  return {
    comments: comments.filter((_comment, index) => allowed[index]),
    withheld: allowed.filter((value) => !value).length,
  };
}

/** Returned text must be fenced by the caller, including author metadata. */
export function renderWriterComment(comment: PrComment): string {
  return `${comment.author}:\n${comment.body.slice(0, FORGE_COMMENT_CHARS)}`;
}

function threadEntry(thread: PrThread, comments: readonly PrComment[]): string {
  return [
    `${thread.path ?? "(no location)"}${thread.line === undefined ? "" : `:${thread.line}`} | resolved: ${thread.resolved} | outdated: ${thread.outdated}`,
    ...(comments.length ? comments.map(renderWriterComment) : ["(no comments from writers)"]),
  ].join("\n");
}

function validateThreads(input: Record<string, unknown>): string | undefined {
  const unknown = Object.keys(input).find((key) => key !== "includeResolved");
  if (unknown) return `Unexpected field: ${unknown}`;
  if ("includeResolved" in input && typeof input.includeResolved !== "boolean") {
    return "includeResolved must be a boolean";
  }
  return undefined;
}

/** Writer-only review threads, retaining empty locations and counting withheld text before capping. */
export function threadsTool(
  binding: ForgeReadBinding,
  resolveRef: () => Promise<PrRef>,
  check: WriterCheck,
): ProviderTool {
  return wrapForgeTool(
    {
      localName: "threads",
      description: "Read writer-authored review threads for the bound PR.",
      inputSchema: {
        type: "object",
        properties: { includeResolved: { type: "boolean", default: false } },
        additionalProperties: false,
      },
      validate: validateThreads,
      async read(ref, input, ctx) {
        const threads = (await _forgeToolsDeps.listReviewThreads(ref, binding.deps, binding.cwd)).filter(
          (thread) => input.includeResolved === true || !thread.resolved,
        );
        const filtered = await Promise.all(threads.map((thread) => writerComments(thread.comments, check)));
        const withheld = filtered.reduce((sum, result) => sum + result.withheld, 0);
        const entries = threads.map((thread, index) => threadEntry(thread, filtered[index].comments));
        const notShown = Math.max(0, threads.length - FORGE_MAX_THREADS);
        const footer = [
          ...(notShown ? [`${notShown} more thread(s) not shown`] : []),
          ...(withheld ? [`withheld ${withheld} comment(s) from authors without write access`] : []),
        ];
        return {
          content: fitToolResult(
            { header: ["Review threads"], entries: entries.slice(0, FORGE_MAX_THREADS), footer },
            ctx.maxBytes,
            "start",
          ),
        };
      },
    },
    resolveRef,
  );
}
