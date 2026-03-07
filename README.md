# telegram-codex-app-bridge

Use a Telegram bot to control a local Codex Desktop instance through `codex app-server`.

## Features

- Telegram private chat or topic-aware group control for a single allowed user
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
3. Optional for group/topic mode: add `TG_ALLOWED_CHAT_ID` and `TG_ALLOWED_TOPIC_ID`.
4. Start the bridge locally with `npm run serve`.
5. Open a private chat with the bot and send `/help`, or talk to it in the configured Telegram topic.

The bridge accepts messages only from the configured Telegram user id.

## Configuration Model

Each device only needs one bot and one `.env` file. Use the same template in all cases:

```dotenv
TG_BOT_TOKEN=123456:telegram-token
TG_ALLOWED_USER_ID=123456789
TG_ALLOWED_CHAT_ID=
TG_ALLOWED_TOPIC_ID=
CODEX_APP_AUTOLAUNCH=true
CODEX_APP_LAUNCH_CMD=codex app
CODEX_APP_SYNC_ON_OPEN=true
CODEX_APP_SYNC_ON_TURN_COMPLETE=false
DEFAULT_CWD=/Users/ganxing/Downloads
DEFAULT_APPROVAL_POLICY=on-request
```

How the optional Telegram fields work:

- Leave `TG_ALLOWED_CHAT_ID` empty: private-chat mode
- Set `TG_ALLOWED_CHAT_ID` only: one allowed group becomes the default conversation scope
- Set both `TG_ALLOWED_CHAT_ID` and `TG_ALLOWED_TOPIC_ID`: that topic becomes the default conversation scope

If multiple bots share one group, each bot should use:

- Its own `TG_BOT_TOKEN`
- The same `TG_ALLOWED_CHAT_ID`
- A different `TG_ALLOWED_TOPIC_ID`

Without `TG_ALLOWED_TOPIC_ID`, every bot in the same group treats the whole group as its default scope.

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

## Telegram Group Checklist

If you use a group or supergroup, do all of the following before testing natural-language chat:

1. Add the bot to the target group.
2. Disable the bot's `privacy mode` in `@BotFather`.
3. Promote the bot to administrator in that group.
4. If you disabled `privacy mode` after the bot was already in the group and natural-language messages still do not arrive, remove the bot and add it back.

Notes:

- `privacy mode` is not required for private chat.
- `/status@botname` and other explicit commands may work even when natural-language group messages do not. Do not use command success as proof that group natural-language mode is configured correctly.
- Topic mode is optional. It is recommended when multiple bots share one group.

## Recommended Usage

The bridge supports three practical layouts:

- Private chat: simplest setup, no group, no topic
- Single bot in one group: set `TG_ALLOWED_CHAT_ID`, keep `TG_ALLOWED_TOPIC_ID` empty unless you want a default topic
- Multiple bots in one group: recommended to use one topic per bot

Recommended group behavior:

- In the bot's default topic, send natural-language messages directly
- In `General` or other topics, explicitly address the bot with `@botname` or `/command@botname`

## Finding Chat And Topic IDs

To discover `TG_ALLOWED_CHAT_ID` and `TG_ALLOWED_TOPIC_ID`:

1. Stop the bridge.
2. Send a message in the target group or topic.
3. Open `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates`.
4. Read:
   - `message.chat.id` -> `TG_ALLOWED_CHAT_ID`
   - `message.message_thread_id` -> `TG_ALLOWED_TOPIC_ID`

If the bridge is still running, it may consume the update before you inspect it.

## Example Group Config

```dotenv
TG_BOT_TOKEN=123456:telegram-token
TG_ALLOWED_USER_ID=123456789
TG_ALLOWED_CHAT_ID=-1001234567890
TG_ALLOWED_TOPIC_ID=42
CODEX_APP_AUTOLAUNCH=true
CODEX_APP_LAUNCH_CMD=codex app
CODEX_APP_SYNC_ON_OPEN=true
CODEX_APP_SYNC_ON_TURN_COMPLETE=false
DEFAULT_CWD=/Users/ganxing/Downloads
DEFAULT_APPROVAL_POLICY=on-request
```

This is the common setup for one bot bound to one topic inside one group.

## Troubleshooting

Common issues:

- Group command works, but natural language does not:
  Usually `privacy mode` is still on, the bot is not admin, or the bot needs to be re-added after the privacy change.
- `getUpdates` shows no recent message:
  Stop the bridge first, then send a fresh message and check again.
- Multiple bots answer in the same group:
  Give each bot a different `TG_ALLOWED_TOPIC_ID`, or keep bots in separate groups.
- A message seemed to get no reply:
  The bridge uses a temporary preview message while the turn is running and deletes it after completion. Check for the final reply, not only the temporary `Working...` preview.

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
