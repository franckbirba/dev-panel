# widget-channel — MCP plugin for the DevPanel widget bridge

This is the public Shelly process's view onto widget chat. It plays the same
role for widget messages that `telegram-multi` plays for Telegram DMs: pull
inbound traffic from a transport (here, the BullMQ `shelly-public-inbound`
queue), surface each message to Claude as a `notifications/claude/channel`
event, and expose an outbound tool (`widget_reply`) that posts back through
the DevPanel API.

## Runtime

- Lives in the `shelly-public` Claude session (DEVPA-159).
- Stdio MCP server. Started by Claude Code via `~/.mcp-public.json`.
- Polls the BullMQ queue `shelly-public-inbound` (Redis on the services VPS).
- POSTs replies to `${DEVPANEL_API}/api/internal/widget/sessions/:id/reply`
  using `WIDGET_INTERNAL_SECRET`. The DevPanel API broadcasts the reply via
  the SSE stream (or buffers it) so the widget tab receives it.

## Env

| Var                       | Purpose                                                |
|---------------------------|--------------------------------------------------------|
| `REDIS_HOST`              | Redis host (default `127.0.0.1`)                       |
| `REDIS_PORT`              | Redis port (default `6379`)                            |
| `WIDGET_INBOUND_QUEUE`    | Override queue name (default `shelly-public-inbound`)  |
| `DEVPANEL_API`            | DevPanel API base URL (e.g. `https://devpanl.dev`)     |
| `WIDGET_INTERNAL_SECRET`  | Shared secret for the internal reply endpoint          |
| `WIDGET_CHANNEL_LOG`      | Log file path (default `/home/deploy/logs/widget-channel.log`) |

## Tools exposed

- `widget_reply(session_id, content, refs?)` — POSTs `{ content, refs }` to
  the internal endpoint. Used by the public Shelly to answer the user.

## Channel envelope

Each inbound widget message is delivered as:

```
<channel source="widget" session_id="..." project_id="..." message_id="..." ts="...">
…user content…
</channel>
```

The session_id is what `widget_reply` needs back. `project_id` comes from
the DevPanel API (the inbound POST is authenticated with the project's
X-API-Key, so the API knows which project the widget belongs to before it
enqueues). `message_id` is the BullMQ job id; if the widget client also
attached its own `message_id`, the envelope surfaces it as
`widget_message_id` for client-side de-dup.
