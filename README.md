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

### Production

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
    "filetype": "lua"
  }
}
```

Context is metadata only — file path, cwd, current mode, and filetype. Buffer/selection content is **not** sent over the socket; the Neovim side handles content injection locally via placeholder substitution (`@this`, `@selection`, `@diagnostics`, etc.) before sending the prompt text.

**pi → Neovim** (events):

```json
{
  "type": "agent_end",
  "message": "done"
}
```

### Key APIs Used

- `pi.sendUserMessage()` — inject prompt as if typed in TUI
- `pi.on("session_start", ...)` — open socket
- `pi.on("session_shutdown", ...)` — close socket
- `pi.on("agent_start/end", ...)` — push events to Neovim

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

### Log Rotation

The log file is append-only and not rotated automatically. To rotate manually:

```bash
# Truncate (keeps file handle valid)
: > ~/.pi/agent/pi-bridge.log

# Or remove and let the extension recreate it on next message
rm ~/.pi/agent/pi-bridge.log
```

## Running Tests

```bash
npm install         # install dependencies
npx vitest run      # run all tests
```

## Related

- [pi-bridge.nvim](https://github.com/junkfactory/pi-bridge.nvim) — Neovim plugin side
