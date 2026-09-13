# pi-bridge.ext

Pi extension for Neovim integration via Unix socket. Pairs with [pi-bridge.nvim](https://github.com/junkfactory/pi-bridge.nvim).

## Architecture

```text
┌─────────────┐     Unix Socket     ┌─────────────────┐
│  pi (TUI)   │◄──────────────────► │ pi-bridge.nvim  │
│  + extension│     JSON msgs       │ (Lua)           │
└─────────────┘                     └─────────────────┘
```

This extension opens a Unix socket on session start, listens for incoming messages from Neovim, and calls `pi.sendUserMessage()` to inject them into the session. It also pushes `agent_start` and `agent_end` events back to Neovim.

## Install

Requires [pi](https://github.com/earendil-works/pi-coding-agent) v0.84+.

### Production

Pin to a release (recommended):

```bash
pi install git:github.com/junkfactory/pi-bridge.ext@v0.1.0
```

Update to a new version with:

```bash
pi install git:github.com/junkfactory/pi-bridge.ext@<version>
```

Or track main (may encounter instability):

```bash
pi install git:github.com/junkfactory/pi-bridge.ext
```

### Development

Clone the repo and install from the local path:

```bash
git clone https://github.com/junkfactory/pi-bridge.ext.git /path/to/pi-bridge.ext
cd /path/to/pi-bridge.ext
npm install          # install dependencies
pi install .         # install from local directory
```

Edits under `src/` require a rebuild before pi picks them up:

```bash
npm run build        # or: npx tsc
```

Alternatively, install from a sibling checkout next to pi-bridge.nvim:

```bash
pi install /path/to/pi-bridge.ext
```

## How It Works

### Socket Lifecycle

1. On `session_start`, the extension computes `sha256(process.cwd())` and creates a socket at `~/.pi/agent/pi-bridge/sockets/<sha256>.sock`
2. If the socket already exists, it attempts to connect — success means another pi instance owns it (noop), failure means stale (remove and recreate)
3. On `session_shutdown`, the socket is cleaned up

### Socket Path

```text
~/.pi/agent/pi-bridge/sockets/<sha256>.sock
```

The hash is SHA256 of the absolute cwd, hex-encoded and truncated to 16 characters. This gives each project directory its own socket with no collisions.

### Message Protocol

JSON over Unix socket, bidirectional:

**Neovim → pi** (prompt with context):

```json
{
  "type": "prompt",
  "text": "fix this function",
  "context": {
    "file": "/home/user/project/src/main.lua",
    "cwd": "/home/user/project",
    "mode": "normal",
    "filetype": "lua",
    "buffer_state": "saved"
  }
}
```

Context is metadata only — file path, cwd, current mode, and filetype. Buffer/selection content is **not** sent over the socket; the Neovim side handles content injection locally via placeholder substitution (`@this`, `@selection`, `@diagnostics`, etc.) before sending the prompt text.

#### `buffer_state` (optional)

String indicating the buffer's save state. When present, the handler uses it to emit tailored hints instead of file links. Valid values: `"nameless"`, `"scratch"`, `"unsaved"`, `"modified"`, `"saved"`.

| State                  | What pi sees                                    |
|------------------------|-------------------------------------------------|
| `saved`                | Clickable file link                             |
| `modified`             | Hint that the file may have unsaved changes     |
| `unsaved` / `nameless` | Hint that the buffer is unsaved (no file path)  |
| `scratch`              | Hint that the path is an ephemeral scratch copy |

When `buffer_state` is absent (e.g. from an older nvim plugin), the handler falls back to checking whether the file exists on disk via `existsSync`.

**pi → Neovim** (events):

```json
{
  "type": "agent_end",
  "message": "done"
}
```

### Edit Approval Gate

The gate intercepts `edit` / `write` tool calls but only for turns that originated from Neovim. Turns typed directly into pi auto-allow (no prompt, no stall). The gate’s origin flag is set by the inbound `prompt` message handler, cleared on `agent_end`, and dropped on every session boundary (`session_start` / `session_before_switch` / `session_shutdown`) for leak-proofing.

```text
tool_call(edit|write)
  ├─ nvim-originated turn? ── no ─► allow (return undefined)
  ├─ gate: file already approved ("a")? ── yes ─► allow
  ├─ compute unified diff (generateUnifiedPatch, disk file vs event.input)
  ├─ broadcast approval_request {id, path, tool, diff}
  ├─ race two surfaces:
  │   ├─ nvim: user answers in Neovim's picker → approval_response {id, decision}
  │   └─ pi: focused y/a/n prompt replaces the input box (ctx.ui.custom, no overlay)
  │       y → "yes"  a → "all"  n → "no"  Esc → "cancelled"
  ├─ first answer wins:
  │   ├─ yes ─► allow
  │   ├─ all ─► add path to per-file approved set, allow
  │   ├─ no  ─► block "User rejected edit to <path>"
  │   └─ cancelled (Esc) ─► block "Edit approval cancelled"
  └─ broadcast approval_resolved {id} exactly once
```

The diff is rendered by pi’s built-in edit/write preview in the transcript; we don’t duplicate it. The pi prompt replaces the input box (no overlay) so pi restores the editor when `done()` is called.

Disconnect semantics:

- **nvim disconnects mid-prompt** → the pi prompt **stays open** awaiting the user’s answer. The gate does not resolve the pending request. The user’s local answer is the only way forward.
- **pi disconnects mid-prompt** → nvim dismisses its picker with a `pi disconnected` message (covered by [pi-bridge.nvim](https://github.com/junkfactory/pi-bridge.nvim)).

Exits from the prompt: `y` / `a` / `n`, Esc (= cancel this edit), or Ctrl+C (= abort the agent turn — handled via `ctx.signal`). No timeouts.

Per-file "all" memory is remembered for the duration of the session; a fresh session re-prompts even for previously-approved files. The memory is cleared on `session_start`, `session_before_switch`, and `session_shutdown`.

Disabling the gate: set `PI_BRIDGE_EDIT_APPROVAL=0` before launching pi. The extension then allows every `edit` / `write` call without prompting (the original behavior).

Bash bypass: the gate only sees `edit` / `write` tool calls — shell mutations (`sed -i`, redirections, …) are invisible to it. To steer the agent toward the gated tools, the extension appends a standing file-editing instruction to every turn's system prompt (`EDIT_TOOL_GUARD` in `src/index.ts`) while the gate is enabled; disabling the gate removes the instruction too.

Headless / RPC modes: when `ctx.hasUI === false` (e.g. `pi -p` or JSON output), the extension auto-approves without opening a prompt — non-interactive workflows aren’t blocked. In RPC mode `ctx.ui.custom` returns undefined; the gate treats this as cancelled (block) to preserve the fail-safe semantics.

#### Approval protocol (NDJSON, additive)

**Neovim → pi** (after the gate prompts):

```json
{ "type": "approval_ack",      "id": "<uuid>" }
{ "type": "approval_response", "id": "<uuid>", "decision": "yes" | "all" | "no" }
```

`approval_ack` is accepted for older-pi compat but is no longer required — there is no ack window. The gate waits indefinitely (bounded by Ctrl+C / agent abort / session reset) for `approval_response`. Either surface (nvim or pi) can answer first; first-wins.

**pi → Neovim** (gate events):

```json
{ "type": "approval_request",  "id": "<uuid>", "tool": "edit" | "write", "path": "<abs>", "diff": "<unified patch>" }
{ "type": "approval_resolved", "id": "<uuid>" }
```

`approval_resolved` is broadcast exactly once on every resolution path (yes / all / no / cancelled / disconnect-while-prompt-open) so Neovim can dismiss its picker even when the user answered in pi.

#### Version pairing

This is a **socket protocol change**. Both repos must be tagged at the same version when shipping approval support. See [Releasing — Cross-repo pairing](#cross-repo-pairing) below.

### Key APIs Used

- `pi.sendUserMessage()` — inject prompt as if typed in TUI
- `pi.on("session_start", ...)` — open socket; clears per-file "all" memory + origin flag
- `pi.on("session_shutdown", ...)` — close socket; clears origin flag
- `pi.on("session_before_switch", ...)` — clear per-file "all" memory + origin flag
- `pi.on("agent_start/end", ...)` — push events to Neovim; `agent_end` clears the origin flag
- `pi.on("tool_call", ...)` — intercept `edit` / `write` for the approval gate (only when origin = nvim)
- `generateUnifiedPatch(path, old, new)` — diff computation (no extra dep)
- `ctx.ui.custom(factory)` — replace the input box with the focused y/a/n prompt (non-overlay; pi restores the editor when `done()` is called)
- `ctx.signal` — agent abort signal; abort cancels the pending request
- `ctx.hasUI` — gate for headless modes (auto-approve when false)

## Logging

Logs to `~/.pi/agent/pi-bridge.log`:

- Socket creation / shutdown
- Messages received from Neovim
- `sendUserMessage()` calls
- Events pushed to Neovim

### Log Level

Set `PI_BRIDGE_LOG_LEVEL` to control verbosity:

```bash
# Default: info
pi -e ./src/index.ts

# Debug: log every message received
PI_BRIDGE_LOG_LEVEL=debug pi -e ./src/index.ts
```

Levels: `trace`, `debug`, `info`, `warn`, `error`.

### Kill Switches

- `PI_BRIDGE_LOG_LEVEL` — minimum log level (above)
- `PI_BRIDGE_EDIT_APPROVAL=0` — disable the edit-approval gate entirely (every `edit`/`write` is allowed without prompting). The runtime kill-switch avoids a rebuild when the gate is in the way; flip back to `1` (or unset) to re-enable.
- `PI_BRIDGE_LOG_FILE` — override the log destination (tests use this)

### Log Rotation

The log file is append-only and not rotated automatically. To rotate manually:

```bash
# Truncate (keeps file handle valid)
: > ~/.pi/agent/pi-bridge.log

# Or remove and let the extension recreate it on next message
rm ~/.pi/agent/pi-bridge.log
```

## Running Tests and Lint

```bash
npm install         # install dependencies
npx vitest run      # run all tests
npx @biomejs/biome check .   # lint + format check (CI runs this too)
```

CI fails on lint errors — run `npx @biomejs/biome check --write .` before committing.

## Releasing

Releases are triggered by tagging. The `tag.sh` script handles validation, build checks, tagging, and pushing:

```bash
./.github/ci/tag.sh 0.1.2   # no 'v' prefix — script adds it
```

This runs `npm ci`, Biome lint, and the Vitest suite, creates a `v0.1.2` jj tag on main, and pushes. The push triggers a CI job that creates the GitHub release with auto-generated notes.

### Cross-repo pairing

Both repos release independently. The exception is a **socket protocol change** — both repos are then tagged at the same version. After both releases exist, a daily CI job appends a pairing line (e.g. "Requires pi-bridge.nvim v0.1.2") to each release's notes.

The edit-approval gate (see [Edit Approval Gate](#edit-approval-gate)) introduces four new message types (`approval_request`, `approval_resolved`, `approval_ack`, `approval_response`). It must ship paired with the matching pi-bridge.nvim version.

### Dry run

```bash
DRY_RUN=1 ./.github/ci/tag.sh 0.1.2
```

Runs checks and prints the tag/push commands without mutating anything.

## Related

- [pi-bridge.nvim](https://github.com/junkfactory/pi-bridge.nvim) — Neovim plugin side
