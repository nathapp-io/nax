# @nathapp/nax-agent

nax's native coding agent as a package: the session contract, the native session adapter and its turn loop over `@nathapp/nax-ai`, the tool set, permission resolution, the OS sandbox, command-safety and cost accounting.

> **Pre-1.0, not yet published.** `0.1.0` is the first planned version. Until `1.0` the API of `.` may change in any minor release. Pin an exact version.

## Install

```bash
npm install @nathapp/nax-agent
```

Requires **Node.js >= 22.19.0**. The package is ESM only and ships no Bun code: it runs on Node, and on Bun, with the default runtime.

## Entry points

- **`@nathapp/nax-agent`** is the supported entry. Every export is named, and none starts with `_`. Its exact names are pinned in [`api/nax-agent.api.txt`](api/nax-agent.api.txt), which CI compares with the built declarations.
- **`@nathapp/nax-agent/internal`** is **nax-only and outside semver.** nax bundles this package and reaches below the public entry for shared helpers, `NaxError`, deep modules and the `_*Deps` test seams. Names, shapes and behaviour there can change in any release, patch included, and a change there is not a breaking change. Do not import it from another project.

## Process-wide slots

The host installs these once, near startup. They are module-level, so they apply to everything in the process.

| Slot | Install | When unset |
|:-----|:--------|:-----------|
| Logger | `setAgentLogger(logger)` (`null` clears) | Logging is silent: `getLogger()` is a no-op logger and `getSafeLogger()` is `null`. |
| Credentials | `configureCredentials({ configDir, readAuthConfig })` | The first credential read throws `NaxError` with code `CREDENTIALS_NOT_CONFIGURED`. There is no default config directory. |
| Runtime | `setAgentRuntime(runtime)` (`null` clears) | `getAgentRuntime()` returns `nodeRuntime`, built on `node:child_process` and `node:fs`. |

`AgentRuntime` is the process and glob contract (`spawn`, `glob`, `globSync`). The Node default is complete; install your own only to change how the agent spawns processes or expands globs.

## Ports the host supplies

Three pieces of host knowledge are passed in as data or functions, because the package cannot know them. Their behaviour when you omit them differs, so check each one.

- **`runDeclaredCommand`** runs a command your project declared (a test or lint command), never one the model wrote. If you do not supply it, the `RunCommand` tool answers `exit 1` with "no declared-command runner is configured for this session" and starts no process. It fails closed.
- **`ProtectedPathsPolicy`** names the paths you own and want kept away from the agent: git pathspecs the Git tool excludes from its default view, gitignore patterns `GitCommit` refuses to stage, the project state directory, the credential directory and the trust-store file the sandbox protects. If you do not supply it, the Git tool excludes nothing from its default view, and `GitCommit` fails closed: it refuses every path and stages nothing until the policy supplies a non-empty `gitIgnorePatterns` (an empty list refuses the same way). Supply it whenever the agent works in a directory that holds files you own. Building a sandboxed session requires it.
- **`commandInterceptor`** may rewrite a command before it runs (for example to prefix a wrapper binary). Rewrites are validated: an argv rewrite may only prefix the original argv with the provider's own binary, and a shell rewrite goes through the same narrowing. If you do not supply one, commands run unchanged. An interceptor that throws, or returns a rewrite that fails validation, is treated as a decline, and the original command runs.

## Status and roadmap

The embedder-facing session API is still being designed, so `0.x` may reshape `.` with a minor bump. See [`CHANGELOG.md`](CHANGELOG.md).

Maintainers: see the [release procedure](https://github.com/nathapp-io/nax/blob/main/packages/nax-agent/RELEASING.md)
for the manual 0.1.0 publish and OTP step, trusted-publisher setup and subsequent tagged releases.

## License

MIT
