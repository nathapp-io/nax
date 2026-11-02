import type { LoopHandlerSet, ToolProvider } from "@nathapp/nax-agent";
import type { MemoryHost } from "@/memory";
import type { NaxPlugin } from "@/plugins";
import type { ResourceCatalog } from "@/resources";
import type { ChatMcpState } from "./chat-mcp";

/** Shared catalog and plugin lifetime owned by a chat host. */
export interface ChatResources {
  readonly catalog: ResourceCatalog;
  readonly toolProviders: readonly ToolProvider[];
  readonly pluginHandlers: LoopHandlerSet;
  readonly naxPlugins: readonly Pick<NaxPlugin, "name" | "provides">[];
  /** The memory host this chat writes notes through; absent when memory is off or unavailable. */
  readonly memory?: MemoryHost;
  readonly mcp?: ChatMcpState;
  readonly teardown: () => Promise<void>;
}
