# telegram-codex-app-bridge

Use a Telegram bot to control a local Codex Desktop instance through `codex app-server`.

## Features

- Telegram private-chat control for a single allowed user
- Local `codex app-server` transport over loopback WebSocket
- Sticky chat-to-thread binding with `/threads`, `/open`, `/new`, `/where`, `/interrupt`
- Chat-scoped model and reasoning-effort control with `/models` and optional `/model`/`/effort` aliases
- Deep-link sync from Telegram into `Codex.app` with `/open` and `/reveal`
- Inline approval buttons for command and file-change approvals
- SQLite persistence for bindings, offsets, approvals, and audit logs
- Streamed Telegram preview via message edits

## Requirements

- macOS with Codex Desktop installed
- `codex` CLI available and authenticated
- Node.js 24+
- A Telegram bot token from `@BotFather`
- Your Telegram numeric user id

## Setup

```bash
npm install
cp .env.example .env
npm run build
npm run doctor
npm run serve
```

## Telegram Setup

1. Create a bot with `@BotFather` and copy the bot token into `TG_BOT_TOKEN`.
2. Get your Telegram numeric user id and place it into `TG_ALLOWED_USER_ID`.
3. Start the bridge locally with `npm run serve`.
4. Open a private chat with the bot and send `/help`.

The bridge accepts messages only from the configured Telegram user id.

## Commands

- `/help`
- `/status`
- `/threads [query]`
- `/open <n>`
- `/new [cwd]`
- `/models` opens the model and reasoning picker
- `/model` and `/effort` are compatibility aliases for the same picker
- `/reveal`
- `/where`
- `/interrupt`
- Plain text sends to the current thread, or creates a new one if none is bound.

## Environment

```dotenv
TG_BOT_TOKEN=123456:telegram-token
TG_ALLOWED_USER_ID=123456789
CODEX_APP_AUTOLAUNCH=true
CODEX_APP_LAUNCH_CMD=codex app
CODEX_APP_SYNC_ON_OPEN=true
CODEX_APP_SYNC_ON_TURN_COMPLETE=false
DEFAULT_CWD=/Users/ganxing/Downloads
DEFAULT_APPROVAL_POLICY=on-request
```

See [`.env.example`](/Users/ganxing/Downloads/telegram-codex-app-bridge/.env.example) for the full list.

## Operations

```bash
npm run build
./scripts/doctor.sh
./scripts/status.sh
./scripts/launchd/install.sh
```

## Contributing

Issues and PRs are welcome. Keep changes small, tested, and documented.
