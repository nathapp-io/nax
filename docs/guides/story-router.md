# Story Router

A story router is a plugin that picks each story's **starting agent profile** at run time, including
for stories `nax plan` already routed. Without it, plan's pick is final for a story's first attempt:
`resolveRouting()` returns early when a story has `routing.complexity` and `routing.testStrategy`,
and plan always writes both.

The hook is opt-in and off by default. Run a router in `shadow` mode first to compare its picks
against plan's, then switch to `apply` once you trust it.

## Configuration

```json
{
  "routing": {
    "router": {
      "mode": "shadow",
      "precedence": "router",
      "timeoutMs": 5000
    }
  }
}
```

| Key | Values | Default | Meaning |
|:---|:---|:---|:---|
| `mode` | `"off"` \| `"shadow"` \| `"apply"` | `"off"` | `off`: never consult. `shadow`: consult, record and log the pick, never use it. `apply`: consult and use the pick per `precedence`. |
| `precedence` | `"router"` \| `"plan"` | `"router"` | Read only in `apply` mode. `router`: the router's pick replaces plan's. `plan`: the pick is used only when plan set no `agentProfileId`. |
| `timeoutMs` | integer > 0 | `5000` | Upper bound on one router call. |

Omitting the block is the same as `mode: "off"`.

The router chooses among the profiles in `routing.agents.profiles`; it has no profile list of its
own. If `mode` is not `off` but `routing.agents` is disabled or has no profiles, the router is not
consulted and nax warns once per run.

## Writing a router

A router is a plugin that provides the existing `router` extension point, a `RoutingStrategy`
(`name` plus `route(story, context)`):

```typescript
export default {
  name: "my-router",
  version: "1.0.0",
  provides: ["router"],
  extensions: {
    router: {
      name: "my-router",
      async route(story, context) {
        // Return null to decline and keep plan's pick.
        return {
          complexity: "medium",
          modelTier: "balanced",
          testStrategy: "tdd-simple",
          reasoning: "short reason",
          agentProfileId: "codex-balanced", // must be an id in routing.agents.profiles
          confidence: 0.8, // optional, 0..1
        };
      },
    },
  },
};
```

Save it where nax loads plugins from (`~/.nax/plugins/` or `<project>/.nax/plugins/`; see
[Loop handlers](loop-handlers.md) for the loading rules). When authoring inside the nax source
tree, the types are `NaxPlugin` from `packages/nax/src/plugins` and `RoutingStrategy` /
`RoutingDecision` from `packages/nax/src/routing`.

For a planned story the hook uses only `agentProfileId` and `confidence`. The router's
`complexity`, `modelTier` and `testStrategy` are not applied, and the story's complexity, test
strategy and reasoning never change. Only the first router the plugin registry returns is
consulted.

While the router is enabled, plugin routers act only as story routers: they no longer classify
unplanned stories through the regular routing chain, because that would apply a shadow-mode pick.

## When the router is consulted

Once per story, in the routing stage, before the story's first attempt. It is skipped when the
story already has an escalation record or a persisted `routing.routerDecision`. Parallel
pre-dispatch routing does not consult it.

The first `story.start` log line can announce plan's starting rung for a story the router has not
seen yet, while the routing stage then runs the router's rung.

## What gets recorded

Plan's pick is always kept for audit. A decision is persisted on the story as
`routing.routerDecision`, with `mode`, `router`, `outcome`, `plannedProfileId` (plan's profile),
`applied` and `decidedAt`. Each consultation logs:

```text
routing.router.decision  { storyId, mode, router, outcome, plannedProfileId, routerProfileId, confidence, applied, latencyMs }
```

| Outcome | Persisted | Effect |
|:---|:---|:---|
| `picked` | yes | `shadow`: `applied: false`. `apply`: applied per the precedence table below. |
| `declined` (null, or no `agentProfileId`) | yes | Plan's pick is used. |
| `unknown-profile` | yes | Plan's pick is used, never `routing.agents.default`. |
| `error` (threw or rejected) | no | Plan's pick is used; warns `routing.router.failed`; retried on the next routing pass. |
| `timeout` | no | Same as `error`. |

A `confidence` outside 0..1, or not a finite number, is dropped. The router never blocks or fails
a run.

In `apply` mode:

| `precedence` | Plan set a profile? | Applied |
|:---|:---|:---|
| `router` | yes or no | yes |
| `plan` | yes | no (recorded with `applied: false`) |
| `plan` | no | yes |

Applying the pick replaces plan's starting tier or model pin with the picked profile's, so an
earlier pin cannot outlive the router's choice.

## Rolling out

1. Install the router plugin and set `mode: "shadow"`.
2. Compare `routerProfileId` with `plannedProfileId` in the `routing.router.decision` lines, and
   with the profile each story actually passed on.
3. Switch to `mode: "apply"`. Use `precedence: "plan"` to let the router fill only stories plan
   left without a profile.

Existing PRDs need no migration. A story without a `routerDecision` is consulted on its next
routing pass once the router is enabled.

## Related

- [Configuration: Routing](configuration.md#routing)
- [Spec: SPEC-story-router-hook.md](../specs/SPEC-story-router-hook.md)
