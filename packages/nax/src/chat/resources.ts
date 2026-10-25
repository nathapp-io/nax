import type { LoopHandlerSet, ToolProvider } from "@nathapp/nax-agent";
import type { NaxPlugin } from "@/plugins";
import type { ResourceCatalog } from "@/resources";

/** Shared catalog and plugin lifetime owned by a chat host. */
export interface ChatResources {
  readonly catalog: ResourceCatalog;
  readonly toolProviders: readonly ToolProvider[];
  readonly pluginHandlers: LoopHandlerSet;
  readonly naxPlugins: readonly Pick<NaxPlugin, "name" | "provides">[];
  readonly teardown: () => Promise<void>;
}
