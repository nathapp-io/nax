import { type Instance, render } from "ink";
import { createElement } from "react";
import { ChatApp, type ChatAppProps } from "./ChatApp";

export { ChatApp, type ChatAppProps } from "./ChatApp";
export const _renderChatDeps = { render };
export function renderChat(props: ChatAppProps): Instance {
  return _renderChatDeps.render(createElement(ChatApp, props), { exitOnCtrlC: false });
}
