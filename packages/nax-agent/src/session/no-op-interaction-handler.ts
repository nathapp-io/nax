/**
 * Shared no-op interaction handler singleton.
 *
 * Kept in runtime so both agent/session layers can reuse the same object
 * identity without importing each other's modules.
 */
export const NO_OP_INTERACTION_HANDLER = {
  async onInteraction() {
    return null;
  },
};
