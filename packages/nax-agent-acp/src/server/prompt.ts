/**
 * ACP prompt content as the one text message S3's `send()` takes (S5 spec §3.2):
 * text verbatim; an embedded text resource as a fenced block headed by its URI;
 * a resource link as its URI. Image, audio and binary content are not
 * advertised and are rejected.
 */
import type { ContentBlock } from "@agentclientprotocol/sdk";
import { invalidParams } from "#src/server/errors";

function fenceFor(text: string): string {
  const longest = Math.max(0, ...Array.from(text.matchAll(/`+/g), (run) => run[0].length));
  return "`".repeat(Math.max(3, longest + 1));
}

function blockText(block: ContentBlock): string {
  switch (block.type) {
    case "text":
      return block.text;
    case "resource_link":
      return block.uri;
    case "resource": {
      const { resource } = block;
      if (!("text" in resource)) throw invalidParams(`binary embedded resource ${resource.uri} is not supported`);
      const fence = fenceFor(resource.text);
      return `${resource.uri}\n${fence}\n${resource.text}\n${fence}`;
    }
    case "image":
    case "audio":
      throw invalidParams(`${block.type} prompt content is not supported`);
  }
}

export function flattenPrompt(blocks: readonly ContentBlock[]): string {
  const parts = blocks.map(blockText).filter((part) => part !== "");
  if (parts.length === 0) throw invalidParams("the prompt has no text");
  return parts.join("\n\n");
}
