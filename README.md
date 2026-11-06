# kilo-readline

> **Disclaimer:** may contain traces of llms, use carefully.

This is a simple readline-style way to run kilo. Without a TUI. It is a terminal
client that talks to the `kilo acp` agent over the Agent Client Protocol (ACP),
using Node's `@agentclientprotocol/sdk`.

Instead of kilo's full terminal UI, this client drives the agent from a plain
readline-style prompt (`kilo> `). It spawns a `kilo acp` child process, opens an
ACP session, and renders model output, tool calls, diffs, tables, and recent
thoughts as colored text directly in the terminal.

Features:

- Custom raw-mode line editor (`src/rawinput.ts`) with multi-line input,
  history navigation, incremental Ctrl+R search, and tab completion of slash
  commands. History is persisted in `.kilo/history`.
- Bracketed-paste handling (`src/paste.ts`) so pasted text is distinguished
  from typed keystrokes and dropped during output or permission prompts.
- Streaming rendering of tool calls: per-kind icons, what-it-is-doing line
  (file path, command, pattern, ...), compact status transitions, search
  output grouping, and inline diffs for edits.
- Markdown rendering for the agent's responses: headers, bold/italic/
  underline, inline code, and column-width-aware tables that wrap to the
  terminal width.
- Permission prompts answered inline via typed digits or `c` to cancel.
- Recent thought display: the tail of the agent's raw reasoning is shown before
  tool calls and periodically during long thinking. The periodic cadence backs
  off over time and is tunable via `KILO_THINK_DISPLAY_*` environment variables.
- Ctrl+C cancels the current turn (and the underlying ACP request) instead of
  killing the client; a second Ctrl+C at an empty prompt exits.

## Requirements

- Node.js
- The `kilo` CLI on PATH (used as the agent process). Install it from
  https://kilo.ai (see https://kilo.ai/docs for setup). The agent command and
  args can be overridden with `KILO_AGENT_CMD` and `KILO_AGENT_ARGS`
  (defaults: `kilo acp`).
- A kilo config with an AI provider, e.g. `~/.config/kilo/kilo.jsonc`. A minimal
  providers/models section looks like:

  ```jsonc
  // ~/.config/kilo/kilo.jsonc
  "provider": {
    "openrouter": {
      "apiKey": "{env:OPENROUTER_API_KEY}",
      "options": { "stream": false, "disableStreaming": true },
      "models": {
        "z-ai/glm-5.2": {
          "options": {
            "stream": false,
            "disableStreaming": true,
            "provider": {
              "order": ["decart", "streamlake", "novita"],
              "allow_fallbacks": true
            }
          }
        }
      }
    }
  },
  "model": "openrouter/z-ai/glm-5.2",
  "small_model": "kilo/kilo-auto/free",
  "agent": {
    "code":     { "model": "openrouter/z-ai/glm-5.2", "options": { "stream": false, "disableStreaming": true } },
    "explore":  { "model": "openrouter/z-ai/glm-5.2", "options": { "stream": false, "disableStreaming": true } },
    "general":  { "model": "openrouter/z-ai/glm-5.2", "options": { "stream": false, "disableStreaming": true } },
    "ask":      { "model": "openrouter/z-ai/glm-5.2", "options": { "stream": false, "disableStreaming": true } }
  }

  // Alternatively, deepseek works well too:
  // "model": "openrouter/deepseek/deepseek-v4-pro",
  // "small_model": "openrouter/deepseek/deepseek-v4-flash",
  // "agent": {
  //   "code":    { "model": "openrouter/deepseek/deepseek-v4-pro" },
  //   "explore": { "model": "openrouter/deepseek/deepseek-v4-pro" },
  //   "general": { "model": "openrouter/deepseek/deepseek-v4-pro" },
  //   "ask":     { "model": "openrouter/deepseek/deepseek-v4-pro" }
  // }
  ```

  These two models — deepseek and glm — are the cheapest good models at the
  moment, but this is just a recommendation; any provider/model kilo supports
  works. deepseek is slightly worse than glm, but better than free models for
  writing the basic structure of a project and good for non-complex tasks (half
  of this tool was written with deepseek).

## Usage

Install dependencies and run in development:

```
npm install
npm run dev
```

Build and run the compiled client:

```
npm run build
npm start
```

Or install it as a `kilo-readline` launcher next to the `kilo` binary:

```
npm run install:bin
kilo-readline
```

Remove it again with `npm run uninstall:bin`.

### Flags

- `-c`, `--continue` — resume the most recent session (requires the agent to
  advertise the `loadSession` capability; the resumed id is stored in
  `.kilo/last_session`).
- `-s <id>`, `--session <id>` — resume a specific session by id (also requires
  `loadSession`). If resume fails or the capability is missing, a new session is
  started instead and a warning is printed. The replayed conversation history
  is drained silently (the last `usage_update` is recorded for `/status`).

### Notable environment variables

- `KILO_AGENT_CMD` / `KILO_AGENT_ARGS` — override the spawned agent command.
- `KILO_THINK_DISPLAY_SHORT_GAP` — milliseconds before the first periodic
  thought display (defaults to `15000`).
- `KILO_THINK_DISPLAY_GAP_STEP` / `KILO_THINK_DISPLAY_LONG_GAP` — periodic
  display backoff step and maximum gap in milliseconds (defaults to `10000` /
  `120000`).

## Privacy-oriented configuration

The client always sets the following environment variables on the spawned
`kilo acp` process:

```text
KILO_PURE=1
DO_NOT_TRACK=1
```

These disable Kilo telemetry initialization and the automatic initialization
of remote-control and indexing integrations. They apply to the child Kilo
process only; they do not disable this client's provider usage checks. Kilo's
model-catalog refreshes and automatic update checks remain enabled.

For an OpenAI-only setup, merge the following into the global
`~/.config/kilo/kilo.jsonc` or project-local `.kilo/kilo.jsonc`. Replace the
model with the OpenAI model approved for the account:

```jsonc
{
  "model": "openai/gpt-5.6-sol",
  "small_model": "openai/gpt-5.6-sol",
  "enabled_providers": ["openai"],
  "share": "disabled",
  "remote_control": false,
  "experimental": {
    "openTelemetry": false
  },
  "permission": {
    "webfetch": "ask",
    "websearch": "ask",
    "repo_clone": "ask"
  }
}
```

Remove non-OpenAI credentials from Kilo's authentication store as well.
`enabled_providers` restricts model selection, but this client still checks
supported providers found in the authentication store for quota information.
The OpenAI-only provider configuration also prevents sessions from qualifying
for Kilo Gateway's personal free-model session export.

With this configuration, prompts and any file contents, diffs, terminal output,
or tool results selected for model context are still sent to OpenAI. Sessions
and tool results are also retained locally by Kilo, primarily in
`~/.local/share/kilo/kilo.db`, while submitted prompts are retained in
`.kilo/history`.

The client also contacts
`https://chatgpt.com/backend-api/wham/usage` for automatic Codex quota updates.
That request includes the OpenAI OAuth token and account ID, but not prompts or
repository contents. Approved shell commands and any explicitly enabled MCP,
plugin, skill, or network tools remain independent outbound paths.

## Local permissions

When a permission prompt is shown, the client adds an extra option beyond the
agent's:

- **Always allow \<tool\> locally** — writes the rule to the project-local
  `<cwd>/.kilo/kilo.jsonc` (kilo's own native project config) and remembers it
  for the current session.

The current tool call proceeds as *allow once* (the agent persists nothing
globally), and the saved rule then:

- **this session**: auto-approves identical calls without re-prompting (the
  client keeps an in-memory allow-set; the agent has no project-config watcher
  and `allow_once` doesn't seed its in-memory allow-list, so the client owns
  this hot-reload);
- **future sessions in this project**: honored by kilo's own config merge
  (project rules override global `~/.config/kilo/kilo.jsonc` per-pattern).

The local file uses the same `permission` schema as the global config:

```jsonc
// .kilo/kilo.jsonc
{
  "permission": {
    "bash": { "npm install *": "allow", "echo *": "allow" },
    "external_directory": { "/tmp/*": "allow" },
    "read": "allow"
  }
}
```

Notes:

- The agent's own "Always allow" writes to the **global** config; this local
  option is the project-scoped alternative.
- JSONC comments are **not** preserved when the client rewrites the file (v1);
  if the existing file is unparseable it is backed up to
  `.kilo/kilo.jsonc.bak` before being rewritten.

## Slash commands

Most slash commands match the kilo TUI. `/exit`, `/quit`, `/help`, `/status`,
and `/compact` are implemented client-side here; the rest
are forwarded to the agent. Type `/help` inside the client for the full list.

`/model` (`/models`) switches the active session's model in place, and
`/thinking` chooses the active model's thinking/reasoning (effort) level. Both
apply live via `session/set_config_option` and don't require a restart. When a
model is switched via `/model`, if the new model exposes effort levels the
client then prompts for a thinking level (Enter accepts the model's saved level
from `model.json` when valid, else the level the agent already chose, else the
first level; `c` skips). The
active model's current thinking level is shown as a `thinking:` line in
`/status` (only when the model has effort levels). Level display uses openrouter
reasoning-effort names, with a model-specific alias shown as
`<name> (<openrouter name>)` (e.g. `Max (high)`); a model's "default" resolves to
the actual level it uses. `/thinking` also persists the choice as the model's
default variant to kilo's state file (`~/.local/state/kilo/model.json`), so it
survives restarts. Recently-used models are read from and written to that same
state file's `recent` list (shared with kilo); a legacy per-project
`.kilo/recent_models` file is migrated once and then removed.

`/codex-balance` reports the ChatGPT-subscription rate-limit usage by reading
Kilo's own OAuth login (`~/.local/share/kilo/auth.json`, the `openai` section)
and calling OpenAI's undocumented `chatgpt.com/backend-api/wham/usage`
endpoint. It prints the plan and the percentage left in the rolling 5h/7d
windows with reset times. It never refreshes the token itself — the `kilo acp`
child process keeps the access token rotated, so if the token is expired just
run any kilo turn and retry. Only works for a ChatGPT (subscription) OAuth
login, not an API-key login. (Renamed from `/codex-usage`.)

`/zai-balance` (alias `/glm-balance`) reports the Z.AI **GLM Coding Plan**
quota usage by reading Kilo's own API-key login
(`~/.local/share/kilo/auth.json`, the `zai-coding-plan` section) and calling
the dashboard backend the z.ai `manage-apikey/coding-plan/personal/usage` page
itself uses (`api.z.ai/api/monitor/usage/quota/limit`, plus a best-effort
`/biz/subscription/list` for the plan name). It prints the plan/level and the
percentage left in the rolling 5-hour pool and weekly quota with reset times
and credits used/total. When the subscription payload carries renewal info it
also prints a `renews`/`ends` line (`nextRenewTime` when `autoRenew` is on,
the end of the `valid` range marked "auto-renew off" otherwise); ChatGPT's
equivalent endpoint exposes no billing date, so `/codex-balance` can't show
one. It is gated to sessions whose model routes through a
`zai-coding-plan` / `zai` / `zhipuai` provider, mirroring the codex `openai/`
gate. The login is a plain API key (no acp token rotation to race), so it
fetches on demand; only a missing key clears it.

`/openrouter-balance` shows what is left **for the OpenRouter API key kilo is
using**, read from Kilo's own login (`~/.local/share/kilo/auth.json`, the
`openrouter` section, a plain `sk-or-…` API key) via OpenRouter's
`GET /api/v1/key` and `GET /api/v1/credits`. The headline `remaining` line is
key-scoped: when the key has its own spending limit it shows the key's
`limit_remaining` (e.g. `$0.19 left of $64.00 key limit (resets monthly)`);
for an unlimited key it shows the account credit pool the key draws from
(`total_credits − total_usage`). Below that: the rolling UTC day/week/month
and total spend for the key, colored green/yellow/red by headroom, plus the
full account credit ledger as dim context when the key has its own limit.

`/kilo-gateway-balance` (renamed from `/kilo-balance`) shows your Kilo Gateway
account balance, read from Kilo's own
login (`~/.local/share/kilo/auth.json`, the `kilo` section) via the
`api.kilo.ai` API (base overridable with `KILO_API_URL`). It fetches two
things and shows them side by side, because they are billed independently:

- **Prepaid credits** (`GET /api/profile/balance`) — pay-as-you-go top-ups.
- **Kilo Pass** (`GET /api/trpc/kiloPass.getState`) — the subscription's
  current-period included + free **bonus** credits, usage this period, the
  remaining = included + bonus − usage, and the reset (next billing) date. The
  free bonus credits are the Kilo Pass bonus; an un-unlocked bonus is shown as
  "projected — available to unlock".

It never refreshes the token itself (same reason as `/codex-balance`); re-run a
kilo turn that uses the `kilo` provider, then retry. Per-request spend detail
lives on the web at `https://app.kilo.ai/usage`.

`/kilo-gateway-logs` [page] shows the log of **individual requests** (assistant
messages) routed through the Kilo Gateway, reconstructed **without any network
call**: Kilo exposes only daily usage aggregates over the API (no per-request
endpoint), so instead this reads kilo CLI's own local SQLite database
(`~/.local/share/kilo/kilo.db`, opened read-only in WAL mode — safe alongside
the running `kilo acp` process). Each request row carries its own date, model,
USD cost, in/out/**cache** tokens, and session title. Requests on free models
(`/free` / `:free`) and non-Kilo providers are filtered out. The integer arg is
a **page index**: offset = arg × 10 requests, newest first (e.g.
`/kilo-gateway-logs` or `/kilo-gateway-logs 2`). The local DB path honors
`KILO_DB`. Requires Node's built-in `node:sqlite` (Node ≥ 22.5; pass
`--experimental-sqlite` on 22.5–22.12).

`/sessions` [page] lists the most recent **sessions across all providers** from
the same local `kilo.db`, including session ID, provider, model, and aggregate
cost/tokens (this is the session listing `/kilo-logs` used to show). Free-model
sessions are **included and greyed out**. Same paging arg and requirements as
`/kilo-gateway-logs`.

Note on retention: the kilo CLI stores sessions **indefinitely** in `kilo.db` —
there is no age-based purge, so both log commands span the whole install
history and the database grows without bound (WAL journal alongside). Pruning,
if desired, is manual.

`/status` additionally shows each session's cumulative **cached** (prompt-cache
read) tokens, summed from the local `kilo.db` message history — the ACP
`usage_update` notification only reports `used = input + cache.read` with no
cache split. The cache line appears for the main session and in the compact
"previous" rows when a session has cached reads; it is
best-effort and silently omitted when `kilo.db` or `node:sqlite` is
unavailable.

Every `/status` (and the startup load screen / exit print) includes a
`quota` block with one line per provider that has a login, regardless of the
active model (the quota is account-scoped, not model-scoped). Each line shows
the rolling 5-hour window and the 7-day/weekly window as a remaining percent
with its reset time — the 5h reset as a clock (`HH:MM`), the 7d reset as a
date+clock (`Oct 7 16:42`):

```
  quota
     codex  5h: 99% (14:42)  7d: 88% (Oct 7 16:42)
     zai    5h: 100%         7d: 41% (Oct 2 16:09)
```

(`codex` = ChatGPT subscription via the `openai` OAuth login; `zai` = Z.AI GLM
Coding Plan via the `zai-coding-plan` API key. A window's reset suffix is
omitted when the payload didn't carry one — e.g. the z.ai 5h pool only reports
a reset once credits have been consumed against it.) The same two lines are
printed after every turn, beneath the `🔢 … tokens used, cost …` usage line,
so a finished turn reflects its own consumption. They are re-fetched on each
turn's end (in parallel, after the last token update); a z.ai fetch that times
out keeps the last cached figure rather than blanking it, while a codex fetch
failure clears it (its expired-token case is covered by the `/codex-balance`
"run a kilo turn" hint).

`/compact` compacts the **main** session's context. ACP has no native
compaction method, so this is a client-side summarize-then-seed: the current
session is asked for a concise context brief, a new session is started, and the
brief is sent as its first message. The old session is disposed. Per-session
usage is retained across compaction, so `/status` still shows the
compacted-away session's tokens and cost.

## Tests

```
npm test
```
