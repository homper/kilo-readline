# kilo-readline

> **Disclaimer:** may contain traces of llms, use carefully.

This is a simple readline-style way to run kilo. Without a TUI. It is a terminal
client that talks to the `kilo acp` agent over the Agent Client Protocol (ACP),
using Node's `@agentclientprotocol/sdk`.

Instead of kilo's full terminal UI, this client drives the agent from a plain
readline-style prompt (`kilo> `). It spawns a `kilo acp` child process, opens an
ACP session, and renders model output, tool calls, diffs, tables, and thinking
summaries as colored text directly in the terminal.

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
- Best-effort thinking summarization: a second `kilo acp` subagent running a
  small/free model periodically summarizes the agent's reasoning blocks so long
  thinking shows progress instead of a silent line. Tunable via
  `KILO_THINK_SUMMARY_*` env vars and falls back to a stats line if unavailable.
- Ctrl+C cancels the current turn (and the underlying ACP request) instead of
  killing the client; a second Ctrl+C at an empty prompt exits.

## Requirements

- Node.js
- The `kilo` CLI on PATH (used as the agent process). Install it from
  https://kilo.ai (see https://kilo.ai/docs for setup). The agent command and
  args can be overridden with `KILO_AGENT_CMD` and `KILO_AGENT_ARGS`
  (defaults: `kilo acp`).
- A kilo config with an AI provider, e.g. `~/.config/kilo/kilo.jsonc`. You need
  to set a `small_model` (used by the thinking summarizer; falls back to
  `kilo/kilo-auto/free`). A minimal providers/models section looks like:

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
- `KILO_ACP_BASH_PERMISSION` — default permission for the `bash` tool
  (`ask` (default), `allow`, `deny`).
- `KILO_ACP_ELICITATION_PERMISSION` — auto-answer elicitation prompts
  (`ask` (default), `allow`, `deny`).
- `KILO_THINK_SUMMARY_MODEL` — small model used for thinking summaries
  (defaults to `kilo/kilo-auto/free`, or the config's `small_model`).
- `KILO_THINK_SUMMARY_*` — timing/size tuning knobs for the summarizer.

## Slash commands

Most slash commands match the kilo TUI. `/exit`, `/quit`, `/help`, `/status`,
and `/compact` (alias `/summarize`) are implemented client-side here; the rest
are forwarded to the agent. Type `/help` inside the client for the full list.

`/compact` compacts the **main** session's context. ACP has no native
compaction method, so this is a client-side summarize-then-seed: the current
session is asked for a concise context brief, a new session is started, and the
brief is sent as its first message. The old session is disposed and the
thinking-summarizer subagent is restarted. Per-session usage is retained across
compaction, so `/status` still shows the compacted-away session's tokens and
cost.

## Tests

```
npm test
```
