# pi-bridge.ext

Pi extension for Neovim integration via Unix socket. Pairs with [pi-bridge.nvim](https://github.com/junkfactory/pi-bridge.nvim).

## Architecture

```text
┌─────────────┐     Unix Socket     ┌─────────────────┐
│  pi (TUI)   │◄──────────────────► │ pi-bridge.nvim  │
│  + extension│     JSON msgs       │ (Lua)           │
└─────────────┘                     └─────────────────┘
```

This extension opens a Unix socket on session start, listens for incoming messages from Neovim, and calls `pi.sendUserMessage()` to inject them into the session. It can also push events back to Neovim (agent started, file edited, etc.).

## Install

```bash
pi install git:github.com/junkfactory/pi-bridge.ext
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

The hash is SHA256 of the absolute cwd, hex-encoded (64 chars). This gives each project directory its own socket with no collisions.

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
    "content": "-- buffer or selection content",
    "mode": "visual"
  }
}
```

**pi → Neovim** (events):

```json
{
  "type": "event",
  "event": "agent_end",
  "data": { "summary": "Completed 3 tool calls" }
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

## Related

- [pi-bridge.nvim](https://github.com/junkfactory/pi-bridge.nvim) — Neovim plugin side
