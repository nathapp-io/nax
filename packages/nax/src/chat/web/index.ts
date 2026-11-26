/**
 * `nax chat`'s web wiring, as one module: the resolved `chat.web` settings and the factory that
 * turns them into the pieces a session opens with.
 *
 * Two modules sit behind this barrel, and they are the pair the chat session always uses
 * together -- `createChatWeb` reads the settings and nothing else. `scripts/check-web-chat-only.ts`
 * keeps the web tool factories themselves out of every file but `wiring.ts`; this barrel only
 * re-exports what a chat session needs, so importing it cannot widen that boundary.
 */
export {
  type ChatWebEnv,
  type ChatWebSettings,
  DEFAULT_WEB_EXPOSED_DOMAINS,
  resolveChatWebSettings,
} from "./settings";
export {
  _chatWebDeps,
  type ChatWeb,
  type ChatWebOptions,
  type ChatWebResult,
  createChatWeb,
  gitRemoteHostsOf,
  searchAllowOrigins,
} from "./wiring";
