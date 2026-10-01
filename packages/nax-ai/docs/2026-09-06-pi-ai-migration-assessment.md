# Should nax-ai stop delegating to pi-ai and hand-roll the wire?

**Date:** 2026-09-06 · **Verdict: not yet — but the trigger has fired, so start step 0 now.**

This is a decision record, written to be read cold. It states the verdict, the
evidence behind it, the commands that re-derive that evidence, and the specific
conditions that would reverse it. Nothing here depends on a conversation.

**State it was written against:**

| Thing | Value |
|---|---|
| nax-ai | `main`, `0.1.9` published (PR #31, #32) |
| pi-ai pin | `0.84.4` — unchanged since the scaffold commit `d4b4c0f`; upstream is `0.85.1` |
| pi-ai catalog | generated `2026-08-28`, 1,290 models / 39 providers |
| nax | `main` `0d195eb2a`, nax-ai pin `0.1.9` (PR #1890) |

---

## 1. The verdict

**Do not hand-roll the wire yet.** The seam is ready; the *evidence* is not. But
native is now doing production code-writing work, so the clock has started.

The order of operations matters more than the answer:

0. **Diagnose nax#1878** (below). It is live money and it tells you whether the
   cost problem is even in the layer you are considering rewriting.
1. **Bump pi-ai `0.84.4` → `0.85.1`.** Never bumped since the scaffold. Cheapest
   real test of the lockstep-churn risk, and it refreshes the catalog.
2. **Build the deferred live drift detector** (ROADMAP "Deferred items"), now
   against the real native traffic corpus rather than synthetic calls.
3. **Only then hand-roll `openai-completions`**, one protocol, registered as a
   second backend and run in shadow against live traffic.

---

## 2. Why not now

### 2.1 The seam is genuinely ready — this is not the blocker

Exactly seven pi-ai symbols cross the boundary: `Api`, `AssistantMessageEvent`,
`Context`, `Credential`, `Model`, `MutableModels`, `SimpleStreamOptions`. They
are confined to three files totalling 947 of 3,219 `src/` lines, and
`bun run check:pi-ai-imports` enforces that confinement.

```sh
# re-derive the symbol list and the LOC split
grep -rn 'from "@earendil-works/pi-ai' -B25 src/ \
  | grep -E '^\S+[-:]\s+(type )?[A-Za-z]+,?$' | sed 's/.*[-:]\s*//' | tr -d ',' | sort -u
wc -l src/protocols/pi-client.ts src/providers/pi-catalog.ts src/auth/pi-auth.ts
find src -name '*.ts' | xargs wc -l | tail -1
```

nax's real footprint is smaller still. The native profile
(`~/.nax/profiles/native.json`) runs `minimax`, `opencode-go` and `openrouter` —
**two wire formats** (`anthropic-messages`, `openai-completions`), not the ten
pi-ai implements. The default `agent.protocol` is still `acp`, so Claude and
codex traffic never touches nax-ai at all.

### 2.2 The blocker is the absence of an oracle

ROADMAP, "The deferred live-provider drift detector", states it plainly: *"the
tool round-trip this detector would assert has **never been proven against a
live provider** — every tool-call test in the suite runs off recorded fixtures."*

Confirmed:

```sh
ls test/fixtures/recorded/ | wc -l         # 10 fixtures
ls test/live/                              # one file: complete.live.test.ts
grep -rn 'schedule:' .github/workflows/*.yml   # no matches — detector unbuilt
```

**Those fixtures were recorded through pi-ai.** They encode pi-ai's
interpretation of each wire format, not the provider's behaviour. Validating a
hand-rolled replacement against them is circular — it proves the new code agrees
with the code being replaced, *including wherever pi-ai is wrong*. Every defect
found on 2026-09-06 was that class, and none would have failed a fixture.

### 2.3 pi-ai friction is real, but lands where the architecture put it

Four defects/limits surfaced in one day:

| Finding | Reachable from outside? |
|---|---|
| `compat.sendSessionAffinityHeaders` defaults false → OpenRouter session id never sent | Yes — fixed in 0.1.9 via `VENDOR_SESSION_HEADERS` |
| `User-Agent: pi (<platform>…)` hardcoded for every consumer | Yes — `ProtocolOptions.clientApp`, 0.1.9 |
| `originator: "pi"` hardcoded on the codex path | **No.** Cosmetic attribution only |
| `compat.vercelGatewayRouting` applied only in `openai-completions`, while all 225 bundled `vercel-ai-gateway` entries are `anthropic-messages` — branch cannot fire | N/A, nothing sets it |

Three of four routed around in under a day using a vendor table the design
provides. That is the seam working, not evidence against it. Cost of pi-ai today
is measured in hours per incident.

Counter-datum in pi-ai's favour: **pinned at `0.84.4` since the scaffold, nine
nax-ai releases shipped on it, never broken by upstream.** The "lockstep
multi-weekly releases" hazard from the feasibility analysis has not materialised
— though it also has not been *tested*, because the pin has never moved.

### 2.4 Deleting the wire backends does not remove pi-ai

`defaultProviders()` (`src/providers/pi-catalog.ts`) imports
`@earendil-works/pi-ai/providers/all` for 1,290 models: pricing (22 tiered),
context windows, thinking-level maps, per-model compat quirks. The catalog was
generated 2026-08-28 and contains every current frontier model, so staleness is
mild — but it refreshes **only** when pi-ai is bumped, which has never happened.

Replacing the catalog is a separate and larger project (models.dev plus an owned
pricing table) with permanent maintenance cost. Hand-rolling the wire does not
touch it.

---

## 3. What changed on 2026-09-06: native is in production

The earlier reading — native is Phase A/B, read-only ops, Phase C "severable,
can wait indefinitely" (ADR-029) — is **out of date**. On disk:

```sh
cd <nax repo>
find .nax/features -name descriptor.json -newermt "2026-08-30" -exec python3 -c "
import json,sys
for f in sys.argv[1:]:
    try:
        d=json.load(open(f)); print(d.get('agent','?'), d.get('role','?'), f.split('/')[2])
    except Exception: pass
" {} + | sort | uniq -c | sort -rn
```

produced, on 2026-09-06:

```
   5 opencode implementer review-remediation-sweep-2
   5 native   implementer audit-cost-and-grep-fidelity
   4 native   implementer acceptance-integrity
   1 native   implementer dispatch-accounting-integrity   <- live at time of writing
```

**Ten native `implementer` sessions across three features in seven days.**
Implementer writes code — Phase C-class work, in the main repo, in production.

Consequence: a wire regression now costs real money on real stories, which makes
shipping unverified hand-rolled wire code *more* dangerous, not less. But it also
supplies the oracle §2.2 says is missing — a **live traffic corpus** a shadow
backend can be diffed against. The backend registry already allows two backends
to be live simultaneously.

---

## 4. The strongest anti-pi-ai case, tested and cleared

[nax#1878](https://github.com/nathapp-io/nax/issues/1878): MiniMax-M2.7 returns
~3% prompt-cache hits where every other native model gets 86–99% — **3.96M input
tokens re-billed in one run**, $0.906 for a story classified `simple`.

M2.7 routes through `anthropic-messages`, the same gated path that swallowed the
session id, so the natural hypothesis was that pi-ai shapes its request
differently from M3's. **It does not.** Marker placement is identical:

```
MiniMax-M2.7   2 turns -> system[0] | messages[2].content[0] (user)
               4 turns -> system[0] | messages[6].content[0] (user)
MiniMax-M3     2 turns -> system[0] | messages[2].content[0] (user)
               4 turns -> system[0] | messages[6].content[0] (user)
```

Both models carry `compat: null`; both get a system marker plus one on the last
user message, growing correctly with the conversation. **Whatever splits M2.7
from M3 is not pi-ai's request shaping**, so a hand-roll would not have recovered
that spend. One clear data point against migration urgency.

Reproduce with `scripts/probes/cache-control-placement.ts` (§6).

**Next hypothesis, untested, and nax-side rather than nax-ai-side:** whether
nax's context assembly re-renders the prompt prefix between turns so it is not
byte-stable. That defeats any cache regardless of who writes the wire, and is
testable against existing `prompt-audit` artifacts.

---

## 5. What would reverse this verdict

- **A pi-ai bump that breaks or diverges.** Step 1 tests this directly.
- **A needed provider feature unreachable from outside the seam.** Only
  `originator: "pi"` so far, which is cosmetic.
- **#1878's root cause landing in the wire layer** after the byte-stability
  hypothesis is eliminated.
- **The catalog going stale enough to block model selection.**

Explicitly **not** a reason, per user ruling 2026-09-06: nax's native turn-loop
transport retry (nax#1870) is **ACP parity**, not a pi-ai deficiency. Do not cite
it as migration evidence and do not re-file it.

---

## 6. Reproduction probes

Both use a stub `fetch`, reach no network and spend nothing. Run from the nax-ai
repo root with `bun run <path>`.

### 6.1 Does a header actually reach the socket?

The general technique behind every finding above: **capture the request, do not
read the mapping table.** pi-ai's format tables are gated by flags that live
elsewhere, so reading them tells you what pi-ai *could* send, not what it does.

```ts
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
const models = builtinModels();
const model = models.getModel("openrouter", "z-ai/glm-5.3-flash")!;
let captured: Record<string, string> = {};
const fakeFetch: typeof fetch = async (_i, init) => {
  captured = Object.fromEntries([...new Headers(init?.headers as HeadersInit).entries()]);
  return new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
};
for await (const _ of models.streamSimple(model,
  { messages: [{ role: "user", content: "hi", timestamp: 0 }] },
  { apiKey: "sk-test", sessionId: "SID", fetch: fakeFetch, transport: "sse" })) { /* drain */ }
console.log(captured);
```

Note `openai-codex` cannot be probed this way: pi refuses to build the request
without real OAuth (`Provider is not configured: openai-codex`), even with a
synthetic JWT carrying the `chatgpt_account_id` claim.

### 6.2 Which providers are behind the affinity gate?

```sh
cd node_modules/@earendil-works/pi-ai/dist/providers/data && node -e '
const fs=require("fs"); const rows=[];
for (const f of fs.readdirSync(".")) {
  if(!f.endsWith(".json")||f.startsWith("."))continue;
  const d=JSON.parse(fs.readFileSync(f,"utf8"));
  for (const [api,m] of Object.entries(d)) {
    if(typeof m!=="object")continue;
    const ids=Object.keys(m);
    const on=ids.filter(i=>(m[i].compat||{}).sendSessionAffinityHeaders===true).length;
    rows.push([f.replace(".json",""),api,ids.length,on]);
  }
}
const GATED=new Set(["openai-completions","anthropic-messages"]);
for (const r of rows.filter(r=>GATED.has(r[1])))
  console.log(`${r[3]===r[2]?"OK  ":r[3]>0?"PART":"DROP"} ${r[0]} (${r[1]}) ${r[3]}/${r[2]}`);
'
```

Only `fireworks`, `cloudflare-workers-ai` and `cloudflare-ai-gateway` opt in.
Everything else on those two APIs sends no affinity header at all.

### 6.3 Cache-control marker placement (§4)

Kept as `scripts/probes/cache-control-placement.ts` in this repo.

---

## 7. Settled — do not re-derive

- **`openai` and `openai-codex` need no vendor session entry.** Their APIs
  (`openai-responses`, `openai-codex-responses`) never consult
  `sendSessionAffinityHeaders`; they send the header already. Adding one would
  duplicate it. (openai verified on the wire; codex is a code read — see §6.1.)
- **`minimax`, `minimax-cn`, `vercel-ai-gateway`, `anthropic` are correct
  absences.** None documents a session or affinity header. Vercel's knobs
  (`order`, `sort`, `only`, `caching`, `cache_ttl`, `cache_anchor_items`, `byok`,
  `providerTimeouts`) are body fields under `providerOptions.gateway`, none of
  them a session key. Adding a table entry would invent a header.
- Both rulings are enforced as tests in `test/protocols/session-id.test.ts`.
