# Overriding OpenRouter routing per model

nax can attach OpenRouter provider-routing preferences to a model that it reaches
through the native agent. Use this when the default routing for a model id picks
endpoints you do not want: a slow endpoint, a lower-precision quantization, or a
provider you need to exclude.

Routing is declared on a catalog entry under `agent.native.catalogOverrides`. The
general catalog-override fields (`id`, `protocol`, `contextWindow`, `pricing`, and
so on) are documented in [configuration.md](configuration.md#agent-configuration).
This guide covers only the `openRouterRouting` block.

## Quick start

```json
{
  "agent": {
    "native": {
      "catalogOverrides": [
        {
          "provider": "openrouter",
          "models": [
            {
              "id": "deepseek/deepseek-v4-flash",
              "protocol": "openai-completions",
              "contextWindow": 163840,
              "supportsTools": true,
              "thinkingLevels": ["off"],
              "pricing": { "input": 0.25, "output": 1, "cacheRead": 0, "cacheWrite": 0 },
              "openRouterRouting": {
                "quantizations": ["fp8"],
                "preferred_min_throughput": { "p90": 40 },
                "preferred_max_latency": { "p90": 3 }
              }
            }
          ]
        }
      ]
    }
  }
}
```

Select the model with an ordinary pin. The declared id is the whole address:

```json
"review": { "semantic": { "model": { "agent": "native", "model": "openrouter/deepseek/deepseek-v4-flash" } } }
```

## The routing keys

Keys are OpenRouter's own wire field names, in snake_case, and nax passes them
through unchanged. Declare only the ones you need.

| Key | Type | Meaning |
|:----|:-----|:--------|
| `quantizations` | string array | Only use endpoints at these precisions, e.g. `["fp8"]`. |
| `sort` | `"price"`, `"throughput"` or `"latency"` | Order endpoints by this metric. |
| `only` | string array | Use only these provider slugs. |
| `ignore` | string array | Never use these provider slugs. |
| `order` | string array | Try these provider slugs in sequence. |
| `allow_fallbacks` | boolean | Whether backup providers may serve the request. |
| `require_parameters` | boolean | Only providers that support every request parameter. |
| `data_collection` | `"deny"` or `"allow"` | `"deny"` keeps the request off endpoints that may store or train on it. |
| `zdr` | boolean | Only Zero Data Retention endpoints. |
| `preferred_min_throughput` | number or percentile object | Minimum tokens per second. |
| `preferred_max_latency` | number or percentile object | Maximum latency in seconds. |

Not supported: `max_price` and `enforce_distillable_text`. An unknown key fails at
config load, so a typo cannot silently drop a preference.

## Throughput and latency targets

Both `preferred_min_throughput` and `preferred_max_latency` accept two forms.

A plain number applies to the 50th percentile:

```json
"openRouterRouting": { "preferred_min_throughput": 40 }
```

A percentile object sets a cutoff per percentile. Use any of `p50`, `p75`, `p90`,
`p99`, and set only the ones you care about:

```json
"openRouterRouting": {
  "preferred_min_throughput": { "p50": 60, "p90": 40 },
  "preferred_max_latency": { "p99": 8 }
}
```

Units:

- `preferred_min_throughput` is tokens per second. Higher is better.
- `preferred_max_latency` is seconds. Lower is better.

Values must be positive. An empty percentile object (`{}`) is rejected, as is a
zero, negative or string value.

These are preferences that OpenRouter applies when it selects endpoints. They are
not guarantees about any single request. Check the behaviour you need against
real calls before relying on a cutoff.

## Rules that prevent silent misrouting

- **Routing only reaches the wire on `protocol: "openai-completions"`.** A routing
  block on any other protocol is rejected at config load. OpenRouter serves models
  on several APIs, but only the OpenAI-completions path sends the `provider` field.
- **An empty block is rejected.** `"openRouterRouting": {}` says nothing, so nax
  refuses it. Omit the key to leave routing unset.
- **Pair `sort` with `quantizations`.** A sort change can pick a lower-precision
  endpoint that you did not intend. Pinning `quantizations` removes that risk.
- **Keep routing fixed across comparisons.** Two runs with the same model id but
  different routing can hit different providers. When you compare models or
  configurations, hold the routing constant on every arm.

## Troubleshooting

| Symptom | Cause |
|:--------|:------|
| Config load fails on `openRouterRouting` | An unknown key, a bad enum value, a non-positive number, or an empty object. The error names the failing field. |
| Config load fails with "must not be empty" | The block has no keys. Remove it or add a preference. |
| Config load fails mentioning `openai-completions` | The model's `protocol` is not `"openai-completions"`. |
| The routing has no effect | The model is not selected through the native agent, or the pin uses a different model id than the declared one. |
