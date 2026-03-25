/**
 * Plugin Validator
 *
 * Runtime type checking for plugin modules.
 * Validates plugin shape and ensures all required extensions are present.
 */

import { getLogger } from "../logger";
import type { NaxPlugin, PluginType } from "./types";

/**
 * Safely get logger instance, returns null if not initialized
 */
function getSafeLogger() {
  try {
    return getLogger();
  } catch {
    return null;
  }
}

const VALID_PLUGIN_TYPES: readonly PluginType[] = [
  "optimizer",
  "router",
  "agent",
  "reviewer",
  "context-provider",
  "reporter",
  "post-run-action",
] as const;

/**
 * Validate a plugin module at runtime.
 *
 * Returns the plugin if valid, null if invalid (with warning logged).
 *
 * @param module - The module to validate (can be any type)
 * @returns The validated plugin or null
 */
export function validatePlugin(module: unknown): NaxPlugin | null {
  // Must be an object
  if (typeof module !== "object" || module === null) {
    getSafeLogger()?.warn("plugins", "Plugin validation failed: module is not an object");
    return null;
  }

  const plugin = module as Record<string, unknown>;

  // Validate name
  if (typeof plugin.name !== "string") {
    getSafeLogger()?.warn("plugins", "Plugin validation failed: missing or invalid 'name' (must be string)");
    return null;
  }

  // Validate version
  if (typeof plugin.version !== "string") {
    getSafeLogger()?.warn(
      "plugins",
      `Plugin '${plugin.name}' validation failed: missing or invalid 'version' (must be string)`,
    );
    return null;
  }

  // Validate provides
  if (!Array.isArray(plugin.provides)) {
    getSafeLogger()?.warn("plugins", `Plugin '${plugin.name}' validation failed: 'provides' must be an array`);
    return null;
  }

  if (plugin.provides.length === 0) {
    getSafeLogger()?.warn("plugins", `Plugin '${plugin.name}' validation failed: 'provides' must not be empty`);
    return null;
  }

  for (const type of plugin.provides) {
    if (!VALID_PLUGIN_TYPES.includes(type as PluginType)) {
      getSafeLogger()?.warn(
        "plugins",
        `Plugin '${plugin.name}' validation failed: invalid plugin type '${type}' in 'provides'`,
      );
      return null;
    }
  }

  // Validate setup (optional)
  if ("setup" in plugin && typeof plugin.setup !== "function") {
    getSafeLogger()?.warn("plugins", `Plugin '${plugin.name}' validation failed: 'setup' must be a function`);
    return null;
  }

  // Validate teardown (optional)
  if ("teardown" in plugin && typeof plugin.teardown !== "function") {
    getSafeLogger()?.warn("plugins", `Plugin '${plugin.name}' validation failed: 'teardown' must be a function`);
    return null;
  }

  // Validate extensions
  if (typeof plugin.extensions !== "object" || plugin.extensions === null) {
    getSafeLogger()?.warn("plugins", `Plugin '${plugin.name}' validation failed: 'extensions' must be an object`);
    return null;
  }

  const extensions = plugin.extensions as Record<string, unknown>;

  // Validate each extension type in provides
  for (const type of plugin.provides) {
    const isValid = validateExtension(plugin.name as string, type as PluginType, extensions);
    if (!isValid) {
      return null;
    }
  }

  return plugin as unknown as NaxPlugin;
}

/**
 * Validate a specific extension type.
 *
 * @param pluginName - Plugin name (for error messages)
 * @param type - Extension type to validate
 * @param extensions - Extensions object
 * @returns Whether the extension is valid
 */
function validateExtension(pluginName: string, type: PluginType, extensions: Record<string, unknown>): boolean {
  switch (type) {
    case "optimizer":
      return validateOptimizer(pluginName, extensions.optimizer);
    case "router":
      return validateRouter(pluginName, extensions.router);
    case "agent":
      return validateAgent(pluginName, extensions.agent);
    case "reviewer":
      return validateReviewer(pluginName, extensions.reviewer);
    case "context-provider":
      return validateContextProvider(pluginName, extensions.contextProvider);
    case "reporter":
      return validateReporter(pluginName, extensions.reporter);
    case "post-run-action":
      return validatePostRunAction(pluginName, extensions.postRunAction);
    default:
      getSafeLogger()?.warn("plugins", `Plugin '${pluginName}' validation failed: unknown extension type '${type}'`);
      return false;
  }
}

/**
 * Validate optimizer extension.
 */
function validateOptimizer(pluginName: string, optimizer: unknown): boolean {
  if (typeof optimizer !== "object" || optimizer === null) {
    getSafeLogger()?.warn("plugins", `Plugin '${pluginName}' validation failed: optimizer extension must be an object`);
    return false;
  }

  const opt = optimizer as Record<string, unknown>;

  if (typeof opt.name !== "string") {
    getSafeLogger()?.warn("plugins", `Plugin '${pluginName}' validation failed: optimizer.name must be a string`);
    return false;
  }

  if (typeof opt.optimize !== "function") {
    getSafeLogger()?.warn("plugins", `Plugin '${pluginName}' validation failed: optimizer.optimize must be a function`);
    return false;
  }

  return true;
}

/**
 * Validate router extension.
 */
function validateRouter(pluginName: string, router: unknown): boolean {
  if (typeof router !== "object" || router === null) {
    getSafeLogger()?.warn("plugins", `Plugin '${pluginName}' validation failed: router extension must be an object`);
    return false;
  }

  const rtr = router as Record<string, unknown>;

  if (typeof rtr.name !== "string") {
    getSafeLogger()?.warn("plugins", `Plugin '${pluginName}' validation failed: router.name must be a string`);
    return false;
  }

  if (typeof rtr.route !== "function") {
    getSafeLogger()?.warn("plugins", `Plugin '${pluginName}' validation failed: router.route must be a function`);
    return false;
  }

  return true;
}

/**
 * Validate agent extension.
 */
function validateAgent(pluginName: string, agent: unknown): boolean {
  if (typeof agent !== "object" || agent === null) {
    getSafeLogger()?.warn("plugins", `Plugin '${pluginName}' validation failed: agent extension must be an object`);
    return false;
  }

  const agt = agent as Record<string, unknown>;

  const requiredFields = [
    { name: "name", type: "string" },
    { name: "displayName", type: "string" },
    { name: "binary", type: "string" },
    { name: "capabilities", type: "object" },
    { name: "isInstalled", type: "function" },
    { name: "run", type: "function" },
    { name: "buildCommand", type: "function" },
    { name: "plan", type: "function" },
    { name: "decompose", type: "function" },
  ];

  for (const field of requiredFields) {
    if (field.type === "object") {
      if (typeof agt[field.name] !== "object" || agt[field.name] === null) {
        getSafeLogger()?.warn(
          "plugins",
          `Plugin '${pluginName}' validation failed: agent.${field.name} must be an object`,
        );
        return false;
      }
    } else {
      // Validate field.type is a valid typeof result before comparison
      const expectedType = field.type as string;

      // Use explicit type checks instead of dynamic typeof comparison
      let isValid = false;
      if (expectedType === "string") {
        isValid = typeof agt[field.name] === "string";
      } else if (expectedType === "number") {
        isValid = typeof agt[field.name] === "number";
      } else if (expectedType === "boolean") {
        isValid = typeof agt[field.name] === "boolean";
      } else if (expectedType === "symbol") {
        isValid = typeof agt[field.name] === "symbol";
      } else if (expectedType === "undefined") {
        isValid = typeof agt[field.name] === "undefined";
      } else if (expectedType === "function") {
        isValid = typeof agt[field.name] === "function";
      } else if (expectedType === "bigint") {
        isValid = typeof agt[field.name] === "bigint";
      } else {
        getSafeLogger()?.warn(
          "plugins",
          `Plugin '${pluginName}' validation failed: invalid type constraint '${expectedType}'`,
        );
        return false;
      }

      if (!isValid) {
        getSafeLogger()?.warn(
          "plugins",
          `Plugin '${pluginName}' validation failed: agent.${field.name} must be a ${expectedType}`,
        );
        return false;
      }
    }
  }

  return true;
}

/**
 * Validate reviewer extension.
 */
function validateReviewer(pluginName: string, reviewer: unknown): boolean {
  if (typeof reviewer !== "object" || reviewer === null) {
    getSafeLogger()?.warn("plugins", `Plugin '${pluginName}' validation failed: reviewer extension must be an object`);
    return false;
  }

  const rev = reviewer as Record<string, unknown>;

  if (typeof rev.name !== "string") {
    getSafeLogger()?.warn("plugins", `Plugin '${pluginName}' validation failed: reviewer.name must be a string`);
    return false;
  }

  if (typeof rev.description !== "string") {
    getSafeLogger()?.warn("plugins", `Plugin '${pluginName}' validation failed: reviewer.description must be a string`);
    return false;
  }

  if (typeof rev.check !== "function") {
    getSafeLogger()?.warn("plugins", `Plugin '${pluginName}' validation failed: reviewer.check must be a function`);
    return false;
  }

  return true;
}

/**
 * Validate context-provider extension.
 */
function validateContextProvider(pluginName: string, provider: unknown): boolean {
  if (typeof provider !== "object" || provider === null) {
    getSafeLogger()?.warn(
      "plugins",
      `Plugin '${pluginName}' validation failed: contextProvider extension must be an object`,
    );
    return false;
  }

  const prov = provider as Record<string, unknown>;

  if (typeof prov.name !== "string") {
    getSafeLogger()?.warn("plugins", `Plugin '${pluginName}' validation failed: contextProvider.name must be a string`);
    return false;
  }

  if (typeof prov.getContext !== "function") {
    getSafeLogger()?.warn(
      "plugins",
      `Plugin '${pluginName}' validation failed: contextProvider.getContext must be a function`,
    );
    return false;
  }

  return true;
}

/**
 * Validate reporter extension.
 */
function validateReporter(pluginName: string, reporter: unknown): boolean {
  if (typeof reporter !== "object" || reporter === null) {
    getSafeLogger()?.warn("plugins", `Plugin '${pluginName}' validation failed: reporter extension must be an object`);
    return false;
  }

  const rep = reporter as Record<string, unknown>;

  if (typeof rep.name !== "string") {
    getSafeLogger()?.warn("plugins", `Plugin '${pluginName}' validation failed: reporter.name must be a string`);
    return false;
  }

  // At least one event handler is optional, but all must be functions if present
  const eventHandlers = ["onRunStart", "onStoryComplete", "onRunEnd"];
  for (const handler of eventHandlers) {
    if (handler in rep && typeof rep[handler] !== "function") {
      getSafeLogger()?.warn(
        "plugins",
        `Plugin '${pluginName}' validation failed: reporter.${handler} must be a function`,
      );
      return false;
    }
  }

  return true;
}

/**
 * Validate post-run-action extension.
 */
function validatePostRunAction(pluginName: string, action: unknown): boolean {
  if (typeof action !== "object" || action === null) {
    getSafeLogger()?.warn(
      "plugins",
      `Plugin '${pluginName}' validation failed: postRunAction extension must be an object`,
    );
    return false;
  }

  const pra = action as Record<string, unknown>;

  if (typeof pra.name !== "string") {
    getSafeLogger()?.warn("plugins", `Plugin '${pluginName}' validation failed: postRunAction.name must be a string`);
    return false;
  }

  if (typeof pra.description !== "string") {
    getSafeLogger()?.warn(
      "plugins",
      `Plugin '${pluginName}' validation failed: postRunAction.description must be a string`,
    );
    return false;
  }

  if (typeof pra.shouldRun !== "function") {
    getSafeLogger()?.warn(
      "plugins",
      `Plugin '${pluginName}' validation failed: postRunAction.shouldRun must be a function`,
    );
    return false;
  }

  if (typeof pra.execute !== "function") {
    getSafeLogger()?.warn(
      "plugins",
      `Plugin '${pluginName}' validation failed: postRunAction.execute must be a function`,
    );
    return false;
  }

  return true;
}
