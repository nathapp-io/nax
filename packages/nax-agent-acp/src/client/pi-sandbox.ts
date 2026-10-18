/** pi's per-command confirmation gate plus a spawn-time sandbox wrapper. */
import { PI_SHELL_GATE_SOURCE } from "#src/client/shell-rules";
import { sandboxWrapSnippet } from "#src/client/shell-sandbox";

/** Generate a standalone extension; piModule is replaceable by a test fixture. */
export function piSandboxGateSource(prefix: string, piModule = "@earendil-works/pi-coding-agent"): string {
  return `import { createBashTool } from ${JSON.stringify(piModule)};
${sandboxWrapSnippet(prefix)}
${PI_SHELL_GATE_SOURCE.replace("export default function", "function")}
export default function naxSandboxGate(pi) {
  naxShellGate(pi);
  const bash = createBashTool(process.cwd(), {
    spawnHook: ({ command, cwd, env }) => ({ command: naxSandboxWrap(command), cwd, env }),
  });
  pi.registerTool({
    ...bash,
    execute(id, params, signal, onUpdate) {
      return bash.execute(id, params, signal, onUpdate);
    },
  });
}
`;
}
