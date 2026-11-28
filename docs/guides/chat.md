---
title: Chat
description: Using nax as an interactive coding agent in the terminal — modes, models, files and images, subagents, background jobs, web tools and configuration
---

# Chat

`nax chat` opens an interactive coding agent in your terminal. It is the default command, so a bare
`nax` starts it. Chat works in the current repository: it reads, edits and runs code with you, and it
can launch `nax plan`, `nax run` and PR reviews as background jobs when you want nax to take a
feature the rest of the way.

```bash
nax                          # open a new chat session in the current directory
nax --resume                 # resume the latest saved session
nax --resume <id>            # resume a specific session
nax --model <provider/model> # pick the model for this session
nax --mode full              # start without approval prompts (default: guarded)
nax -d ../other-repo         # work in another directory
nax --profile <name>         # overlay a config profile (repeatable)
```

Before the first session, trust the project folder (`nax trust add "$PWD"`) and give the native
agent credentials (`nax auth login <provider>`, or the provider's environment variable). See
[Agents](agents.md) for how the native agent picks its models.

---

## Permission modes

Chat has two modes. `shift+tab` or `/mode` switches between them during a session.

| Mode | What it does |
|:-----|:-------------|
| `guarded` (default for new sessions) | Actions that match an `ask` rule wait for your approval, and `deny` rules refuse outright. A command that would run outside the OS sandbox, or while the sandbox is unavailable, asks first, and so does a tool discovered during the session. With memory `askOnSave` on, saving or forgetting a memory note asks too. |
| `full` | No approval prompts. Bash runs raw, still inside the OS sandbox when it is enabled. |

Guarded mode reads its rules from the `tui` block of `execution.permissions`:

```json
{
  "execution": {
    "permissions": {
      "tui": {
        "bashApproval": "gated",
        "ask": ["Bash(git push*)", "Write"],
        "deny": ["Bash(rm -rf*)"]
      }
    }
  }
}
```

- `bashApproval` is `raw` or `gated`. `escalate` has no meaning in chat and is treated as `gated`.
- Under `raw`, `Bash(...)` patterns in `ask` and `deny` are not consulted; nax warns at start.
- Approvals you choose to remember are kept per project. List and revoke them with
  `nax approvals list` and `nax approvals rm` ([Approvals](approvals.md)).

See [Permissions](permissions.md) for the rule syntax and
[Sandbox & Command Safety](sandbox-and-command-safety.md) for what the sandbox confines.

---

## Models and agents

- `/model` (or `--model` at start) switches the model. `ctrl+t` or `/effort` cycles the reasoning
  effort.
- **ACP agents in chat.** A model named `acp:<agent>` or `acp:<agent>/<model>` runs the session on an
  external agent over ACP instead of nax's native agent. Chat supports `claude` (Claude Code),
  `codex` and `cursor`. The agent brings its own tools, skills, MCP servers and subagents, so
  `/skills`, `/mcp` and `/agents` say they are not available, `/compact` goes to the agent as typed,
  and commands whose template runs shell lines refuse to expand.

---

## Writing messages

| Input | Effect |
|:------|:-------|
| `enter` | Send. `shift+enter` or `alt+enter` adds a newline. |
| `@path` | Mention a file. Its contents go with the message, and the `@` menu completes paths. |
| `ctrl+v` or `/image [path]` | Attach an image from the clipboard or a file. Images reach models that read images; a text-only model receives the path only. |
| `/feature <name> [message]` | Load a feature's `spec.md` (and `prd.json`, when present) into the conversation. |
| `ctrl+s` | Steer the running turn, or interrupt it and send. |
| `up` on an empty prompt | Edit queued messages. Lines typed while a turn runs are queued. |
| `esc` | Close an overlay, or interrupt the running turn. |

---

## Built-in commands

Type `/` to open the command menu. Skills and commands from your resource catalog appear in the same
menu (see [Skills, commands and subagents](#skills-commands-and-subagents)).

| Command | What it does |
|:--------|:-------------|
| `/help` | Show commands, skills and keyboard controls |
| `/mode` | Switch permission mode |
| `/model` | Switch model |
| `/effort` | Switch reasoning effort |
| `/sessions` | List saved sessions |
| `/resume` | Resume a saved session |
| `/clear` | Clear the conversation |
| `/cost` | Show session cost |
| `/feature` | Load a feature spec into the conversation |
| `/skills` | List skills |
| `/plugins` | List plugins and what they provide |
| `/image` | Attach an image to the next message |
| `/mcp` | List MCP servers |
| `/agents` | List agents |
| `/compact` | Compact the conversation history |
| `/jobs` | Show nax jobs and background tasks |
| `/memory` | Show memory notes and sync status |
| `/quit` | Quit nax chat |

---

## Keyboard

| Key | Action |
|:----|:-------|
| `pgup` / `pgdn` | Scroll a page |
| `shift+up` / `shift+down` | Scroll a line |
| `home` / `end` | Jump to the top / the latest output |
| `ctrl+o` | Expand or collapse details |
| `ctrl+g` | Open the jobs picker |
| `shift+tab` | Cycle permission mode |
| `ctrl+t` | Cycle reasoning effort |
| `ctrl+b` | Move the running command to the background (`ctrl+b ctrl+b` inside tmux) |
| `ctrl+c` | Quit when idle; interrupt when running (press again to quit) |

Live Bash output and the shell view are described in [Chat Shell Output](chat-shells.md).

---

## Skills, commands and subagents

Chat builds a resource catalog when the session opens. It reads:

- your Claude Code setup: the project's `.claude/` skills, commands, agents and settings hooks, your
  user `~/.claude/` skills and commands, installed Claude Code plugins, and MCP servers from
  `.mcp.json` and `.claude.json`;
- shared user skills in `~/.agents/skills`;
- nax's own user agents in `~/.nax/agents` (honours `NAX_GLOBAL_CONFIG_DIR`).

A command file can include shell lines written as `` !`command` ``. When you run the command, each
line runs first and its output replaces it in the message; if one fails, the command is not sent.
This works on native models only.

Skills load on demand. Named agents run as **subagents**: the chat model hands a self-contained
task to one, in the foreground or in the background, and gets its result back without filling the
main conversation. `/agents` lists them; `/skills` and `/plugins` show what the catalog found.

---

## Background jobs

Chat can launch nax's billed steps for you as background jobs:

| Job | Same as |
|:----|:--------|
| plan | `nax plan -f <feature> [--from <spec>]` |
| run | `nax run -f <feature>` (optional `--publish` mode and cost cap) |
| publish | publishing a finished feature's branch |
| bot review | `nax bot review <pr>` |
| bot fix | `nax bot fix <pr>` |

Every launch asks for your explicit approval first. For a multi-step task, chat can instead propose
a **chain**, an ordered list of billed steps you approve once; chat checks each step's result before
it starts the next, and you can stop the chain without cancelling the jobs already running. Before
proposing a step, chat reads where the feature stands (spec, PRD, last run, workflow verdict,
branch).

`ctrl+g` or `/jobs` lists jobs and background tasks with their recent logs; cancelling a job asks
first. While a run is in progress, chat can answer the run's queued questions or bring them to you.

Defaults for these launches live under `chat.workflow`:

```json
{
  "chat": {
    "workflow": {
      "plan":      { "profiles": ["fast-plan"] },
      "run":       { "profiles": [] },
      "botReview": { "profiles": [], "model": "provider/model" },
      "botFix":    { "profiles": [], "model": "provider/model" },
      "specFixRounds": 2
    }
  }
}
```

---

## Web tools

Web search and fetch are off until you turn them on:

```json
{
  "chat": {
    "web": {
      "enabled": true,
      "search": { "backend": "tavily", "maxResults": 8 },
      "fetch": { "maxBytes": 200000, "timeoutMs": 15000 }
    }
  }
}
```

- `search.backend` is `tavily`, `brave`, `exa` or `searxng`. Hosted backends read their key from the
  environment only: `TAVILY_API_KEY`, `BRAVE_SEARCH_API_KEY` or `EXA_API_KEY`. `searxng` needs
  `searxngUrl` (http or https) instead.
- `maxResults` is 1-20 (default 8). `fetch.maxBytes` is 1,000-5,000,000 (default 200,000) and
  `fetch.timeoutMs` is 1,000-60,000 (default 15,000).
- **After reading the web, the session is exposed.** A page may contain instructions an attacker
  wrote, so from then on chat asks before any `git push`, any command that runs outside the
  sandbox or asks for full network access, and any `web__fetch` of a URL the session has not been
  shown.
- With the web enabled, sandboxed commands can reach any host until the session is exposed. After
  that, they can reach only package registries, GitHub content hosts and your repository's
  git remote hosts. `exposedAllowedDomains` replaces the registry and GitHub list; the git remote
  hosts are always added.
- A missing search key disables search only. `web__fetch` needs no key, so it stays available, and
  chat names the variable to set.

---

## Sessions, memory and compaction

- Sessions are saved as you go. `/sessions` lists them; `/resume` or `nax --resume [id]` picks one up.
- Chat reads and writes the same memory notes as `nax run` ([Memory](memory.md)); `/memory` shows
  them and their sync status.
- Long conversations compact automatically, and `/compact` compacts on demand:

```json
{
  "chat": {
    "compaction": {
      "compactAtTokens": 200000,
      "idleCompactAfterMinutes": 55
    }
  }
}
```

`compactAtTokens` is the token count that triggers compaction (0 turns it off).
`idleCompactAfterMinutes` (0-1440, 0 turns it off) compacts in the background after the session has
been idle that long. These settings apply to the chat session only; story sessions and chat
subagents keep `execution.compaction`.

---

## Related

- [Agents](agents.md): native and ACP agents
- [Workflow Mode](workflow-mode.md): what a `nax run` job does
- [Permissions](permissions.md), [Approvals](approvals.md), [Sandbox & Command Safety](sandbox-and-command-safety.md)
- [MCP & Command Interception](mcp-and-interception.md)
- [Chat Shell Output](chat-shells.md)
