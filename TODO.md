# pi-bridge.ext Implementation Plan

> **Keep this plan updated as phases are completed.** Mark phases done, note deviations, and add follow-up items.

## Phase 1: Message Protocol ✅

**Files:** `protocol.ts`, `tests/protocol.test.ts`

Implement the data layer — pure functions, no I/O, no pi dependency.

- [x] Define `InboundMessage` / `OutboundEvent` types (expand as needed)
- [x] `parseMessage(raw)`: JSON parse, validate type + required fields, return typed message or null
- [x] `serializeEvent(event)`: JSON.stringify + newline delimiter
- [x] Message framing: newline-delimited JSON (`\n` separator) via `frameBuffer()`
- [x] Tests: valid messages, malformed JSON, missing fields, unknown types, framing edge cases (18 tests)

**Why first:** Everything else depends on message types. Pure functions = fast iteration.

## Phase 2: Socket Lifecycle ✅

**Files:** `socket.ts`, `tests/socket.test.ts`

Implement the Unix socket server with idempotent activation.

- [x] `start(socketPath, onMessage)`: create server, bind, listen
- [x] Stale socket detection: try connect → ECONNREFUSED → remove → recreate
- [x] Connection handling: buffer incoming data, split on `\n`, call `onMessage` per line
- [x] `stop()`: close server, remove socket file
- [x] Graceful cleanup on process signals (SIGINT, SIGTERM)
- [x] Socket permissions: 0o600 (user-only)
- [x] Tests: start/stop lifecycle, stale socket handling, message framing, partial messages, multiple connections (9 tests)

**Why second:** Depends on protocol for framing. Isolated from pi API — testable with raw socket clients.

## Phase 3: Message Handler ✅

**Files:** `handler.ts`, `tests/handler.test.ts`

Wire parsed messages to pi API calls.

- [x] `handleMessage(pi, message)`: dispatch by type
- [x] `handlePrompt(pi, msg)`: format context (file, cwd, content, mode) into `pi.sendUserMessage()` call
- [x] Context formatting: include file path + mode as preamble, content as code block
- [x] Tests: mock `ExtensionAPI`, verify `sendUserMessage` called with correct args (8 tests)

**Why third:** Depends on protocol types. Mock pi API for unit tests.

## Phase 4: Entry Point & Integration ✅

**Files:** `index.ts`

Wire everything together in the extension factory.

- [x] `session_start`: compute socket path, ensure dir, start socket server, log startup
- [x] `session_shutdown`: stop socket server, log shutdown
- [x] Connect handler to socket's `onMessage` callback
- [x] Read log level from env (`PI_BRIDGE_LOG_LEVEL`, default "info")
- [ ] Manual smoke test with `pi -e ./src/index.ts`

**Why last:** Glue code. Needs all other modules working.

## Phase 5: Polish & Edge Cases

**Files:** any, based on findings

- [ ] Error handling: malformed messages log warning, don't crash
- [ ] Socket permissions: restrict to user-only (0o600)
- [ ] Log rotation consideration (or document manual rotation)
- [ ] Buffer overflow protection: max message size limit
- [ ] Integration test: start pi with extension, connect with a test client, send message, verify `sendUserMessage` called

## Dependency Graph

```text
Phase 1 (protocol) ──► Phase 2 (socket) ──► Phase 4 (index)
                   └──► Phase 3 (handler) ─┘
                                        └──► Phase 5 (polish)
```

Phases 2 and 3 can be developed in parallel after Phase 1.
