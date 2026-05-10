/**
 * Telegram-out extension for Pi (Pi-Shelly only).
 *
 * Why this exists, in one sentence: Pi-Shelly cannot share a stdio
 * `telegram` MCP server with anyone, so the loop owns the long-lived
 * inbound poller and Pi sends outbound replies via the HTTP Bot API
 * directly through these tools.
 *
 * Background: telegram-multi (the bun grammy plugin) is the *sole*
 * poller for the bot tokens — Telegram returns 409 Conflict if two
 * processes call getUpdates with the same token. Under Claude-Shelly,
 * Claude Code spawns telegram-multi as its own MCP child and uses its
 * `reply` / `react` / `edit_message` / `download_attachment` tools.
 * Under Pi-Shelly, scripts/shelly-pi-loop.js spawns telegram-multi as a
 * long-lived child, so it can't *also* be spawned by the per-pi-run
 * mcp-bridge — that would mean two pollers on the same tokens.
 *
 * Solution: keep telegram out of Pi's mcp-bridge config (set
 * SHELLY_MCP_CONFIG to a file that omits the `telegram` entry — see
 * shelly-pi-loop.js wiring), and register the outbound tools here.
 * These tools talk to Telegram's HTTP Bot API directly, so they
 * coexist peacefully with whatever process is doing the polling.
 *
 * Tools (mirror telegram-multi's tool surface for SOUL.md compat):
 *   reply({ bot_label, chat_id, text, reply_to?, files? })
 *   react({ bot_label, chat_id, message_id, emoji })
 *   edit_message({ bot_label, chat_id, message_id, text })
 *   download_attachment({ bot_label, file_id })
 *
 * Bot tokens are looked up from the `dev_bots` Postgres table by
 * bot_label (same source telegram-multi uses).
 *
 * Loaded via:
 *   pi --extension /home/deploy/projects/dev-panel/infra/pi-extensions/telegram-out
 *
 * Workers do NOT load this — they have no Telegram surface at all.
 */
import { Type } from "typebox";
import pg from "pg";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const TG_API = "https://api.telegram.org";
const INBOX_DIR =
	process.env.TELEGRAM_INBOX_DIR ||
	join(homedir(), ".claude", "channels", "telegram", "inbox");

const pool = new pg.Pool({
	host: process.env.PG_HOST || "10.0.0.2",
	port: Number(process.env.PG_PORT || "5432"),
	user: process.env.PG_USER || "affine",
	password: process.env.PG_PASSWORD,
	database: process.env.PG_DATABASE || "agent_memory",
});

const tokenCache = new Map<string, string>();

async function tokenFor(botLabel: string): Promise<string> {
	const cached = tokenCache.get(botLabel);
	if (cached) return cached;
	const r = await pool.query(
		`SELECT bot_token FROM dev_bots WHERE bot_label = $1 AND status = 'active' LIMIT 1`,
		[botLabel],
	);
	if (r.rows.length === 0) {
		throw new Error(
			`telegram-out: no active dev_bots row with bot_label='${botLabel}'`,
		);
	}
	const token = r.rows[0].bot_token as string;
	tokenCache.set(botLabel, token);
	return token;
}

async function tgCall(
	token: string,
	method: string,
	body: unknown,
	signal?: AbortSignal,
): Promise<unknown> {
	const res = await fetch(`${TG_API}/bot${token}/${method}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
		signal,
	});
	const json = (await res.json()) as { ok?: boolean; result?: unknown; description?: string };
	if (!json.ok) {
		throw new Error(`telegram ${method}: ${json.description || res.status}`);
	}
	return json.result;
}

function ok(payload: unknown) {
	return {
		content: [
			{ type: "text" as const, text: JSON.stringify(payload, null, 2) },
		],
		details: payload as Record<string, unknown>,
	};
}

function asError(stage: string, message: string) {
	return {
		content: [
			{
				type: "text" as const,
				text: JSON.stringify({ ok: false, stage, error: message }, null, 2),
			},
		],
		details: null,
		isError: true,
	};
}

// ---------- reply ----------

const reply = defineTool({
	name: "reply",
	label: "Telegram reply",
	promptSnippet:
		"Send a Telegram message to the user (REQUIRED for any visible response — plain assistant text is invisible on Telegram).",
	promptGuidelines: [
		"You are talking to the user on TELEGRAM, not in a transcript. Your assistant text never reaches them — only the `text` field of a `reply` tool call does.",
		"After every inbound `<channel>` envelope, you MUST end your turn with at least one `reply` tool call. Tool results from `mcp__plane-mcp__*`, `memory_search`, etc. do NOT count as a reply.",
		"Pass `bot_label` and `chat_id` taken verbatim from the inbound `<channel>` envelope's attributes. Use `reply_to: <message_id>` only when threading under an earlier message.",
		"Multi-turn pattern: explore with MCP tools first (memory_search, plane_*, etc.), THEN call `reply` with your synthesized answer. Don't reply mid-exploration; don't forget to reply at the end.",
	],
	description:
		"REQUIRED for every visible response to the user. Plain assistant text is INVISIBLE on Telegram — only text inside this tool's `text` parameter actually reaches the user's chat. If you forget to call this, the user sees nothing and thinks you're dead. Pass bot_label and chat_id from the inbound <channel> envelope's attributes. Optional reply_to (message_id) for quote-threading. Telegram caps a single message at 4096 chars; over that, the tool splits automatically.",
	parameters: Type.Object({
		bot_label: Type.String({
			description:
				"bot_label from the inbound <channel> tag — picks the right bot token to send through.",
		}),
		chat_id: Type.Union([Type.Number(), Type.String()], {
			description: "chat_id from the inbound <channel> tag.",
		}),
		text: Type.String({ description: "Message body (markdown ok)." }),
		reply_to: Type.Optional(
			Type.Union([Type.Number(), Type.String()], {
				description: "message_id to quote-reply. Omit for a normal reply.",
			}),
		),
	}),
	async execute(_id, params, signal) {
		try {
			const token = await tokenFor(params.bot_label);
			const chunks: string[] = [];
			let s = params.text;
			while (s.length > 4096) {
				chunks.push(s.slice(0, 4096));
				s = s.slice(4096);
			}
			chunks.push(s);
			const sent: number[] = [];
			for (let i = 0; i < chunks.length; i++) {
				const replyParams =
					i === 0 && params.reply_to != null
						? { reply_parameters: { message_id: Number(params.reply_to) } }
						: {};
				const r = (await tgCall(
					token,
					"sendMessage",
					{
						chat_id: params.chat_id,
						text: chunks[i],
						...replyParams,
					},
					signal,
				)) as { message_id?: number };
				if (r.message_id != null) sent.push(r.message_id);
			}
			return ok({ ok: true, message_ids: sent });
		} catch (err) {
			return asError("reply", (err as Error).message);
		}
	},
});

// ---------- react ----------

const react = defineTool({
	name: "react",
	label: "Telegram react",
	promptSnippet:
		"Add an emoji reaction to an inbound message (acknowledgement; not a substitute for `reply`).",
	description:
		"Add an emoji reaction to a message. Telegram only allows a small whitelist of emojis as reactions — see Bot API docs. Reactions are silent acknowledgements, NOT substitutes for `reply` — if the user asked a question, you still need to call `reply`.",
	parameters: Type.Object({
		bot_label: Type.String(),
		chat_id: Type.Union([Type.Number(), Type.String()]),
		message_id: Type.Union([Type.Number(), Type.String()]),
		emoji: Type.String({
			description:
				"Single emoji character (e.g. '👍'). Empty string clears reactions.",
		}),
	}),
	async execute(_id, params, signal) {
		try {
			const token = await tokenFor(params.bot_label);
			const reaction = params.emoji
				? [{ type: "emoji", emoji: params.emoji }]
				: [];
			await tgCall(
				token,
				"setMessageReaction",
				{
					chat_id: params.chat_id,
					message_id: Number(params.message_id),
					reaction,
				},
				signal,
			);
			return ok({ ok: true });
		} catch (err) {
			return asError("react", (err as Error).message);
		}
	},
});

// ---------- edit_message ----------

const editMessage = defineTool({
	name: "edit_message",
	label: "Telegram edit message",
	promptSnippet:
		"Edit a message you previously sent (interim progress updates; doesn't trigger push notifications).",
	description:
		"Edit the text of a previously-sent message. Only messages the bot itself sent can be edited. Useful for interim progress updates on long-running tasks. Edits don't trigger push notifications — when work completes, send a fresh `reply` so the user's device pings.",
	parameters: Type.Object({
		bot_label: Type.String(),
		chat_id: Type.Union([Type.Number(), Type.String()]),
		message_id: Type.Union([Type.Number(), Type.String()]),
		text: Type.String(),
	}),
	async execute(_id, params, signal) {
		try {
			const token = await tokenFor(params.bot_label);
			const r = await tgCall(
				token,
				"editMessageText",
				{
					chat_id: params.chat_id,
					message_id: Number(params.message_id),
					text: params.text,
				},
				signal,
			);
			return ok({ ok: true, edited: r });
		} catch (err) {
			return asError("edit_message", (err as Error).message);
		}
	},
});

// ---------- download_attachment ----------

const downloadAttachment = defineTool({
	name: "download_attachment",
	label: "Telegram download attachment",
	promptSnippet:
		"Fetch a Telegram file attachment (photo/document/voice) — call when inbound `<channel>` has `attachment_file_id`.",
	description:
		"Fetch a Telegram file attachment by file_id and save it to the local inbox. Returns the absolute path; the caller should `read` it next. Telegram caps bot downloads at 20MB. Trigger when the inbound `<channel>` envelope has an `attachment_file_id` attribute.",
	parameters: Type.Object({
		bot_label: Type.String(),
		file_id: Type.String({
			description:
				"file_id from the inbound <channel> attachment_file_id attribute.",
		}),
	}),
	async execute(_id, params, signal) {
		try {
			const token = await tokenFor(params.bot_label);
			const meta = (await tgCall(
				token,
				"getFile",
				{ file_id: params.file_id },
				signal,
			)) as { file_path?: string; file_size?: number };
			if (!meta.file_path) {
				return asError("download_attachment", "no file_path in getFile response");
			}
			const url = `${TG_API}/file/bot${token}/${meta.file_path}`;
			const fileRes = await fetch(url, { signal });
			if (!fileRes.ok) {
				return asError(
					"download_attachment",
					`fetch ${url} -> ${fileRes.status}`,
				);
			}
			const buf = Buffer.from(await fileRes.arrayBuffer());
			mkdirSync(INBOX_DIR, { recursive: true });
			const fname = meta.file_path.replace(/[/\\]/g, "_");
			const dest = join(INBOX_DIR, `${Date.now()}-${fname}`);
			writeFileSync(dest, buf);
			return ok({
				ok: true,
				path: dest,
				size: buf.length,
				original: meta.file_path,
			});
		} catch (err) {
			return asError("download_attachment", (err as Error).message);
		}
	},
});

// keep readFileSync imported in case future tools (sendDocument, sendPhoto) need it.
void readFileSync;

/**
 * Reply-fallback safety net.
 *
 * Qwen3-Coder chronically generates user-facing answers as plain assistant
 * text instead of calling the `reply` tool — even with a hardened
 * imperative in the system prompt and a "REQUIRED" tool description.
 * Observed across multiple Telegram inbounds 2026-05-10 (e.g. "Do you see
 * your tools?" → 200-token plain-text response, no tool call, user saw
 * nothing).
 *
 * This hook runs at `turn_end`. If the assistant's final message:
 *   - has visible text content, AND
 *   - made NO `reply` tool call this turn, AND
 *   - we have INBOUND_BOT_LABEL + INBOUND_CHAT_ID env (set by
 *     shelly-pi-loop.js per-message), THEN
 * we send the text to Telegram ourselves via the same HTTP Bot API the
 * `reply` tool uses. The user gets the answer; the model gets a free pass
 * on the missing tool call.
 *
 * Tunable via PI_REPLY_FALLBACK=off to disable (e.g. for the worker path
 * where there's no Telegram surface and INBOUND_* are unset anyway).
 */
function attachReplyFallback(pi: ExtensionAPI) {
	if (process.env.PI_REPLY_FALLBACK === "off") return;
	const botLabel = process.env.INBOUND_BOT_LABEL || "";
	const chatId = process.env.INBOUND_CHAT_ID || "";
	if (!botLabel || !chatId) return; // not running in a Telegram context

	pi.on("turn_end", async (event) => {
		const msg = event.message;
		if (!msg || msg.role !== "assistant") return;
		const content = (msg.content || []) as Array<{
			type?: string;
			text?: string;
			name?: string;
		}>;

		// Did the model already call `reply`? If yes, we're done.
		const calledReply = content.some(
			(c) => (c?.type === "toolCall" || c?.type === "tool_use") && c?.name === "reply",
		);
		if (calledReply) return;

		// Collect any plain text it emitted instead.
		const plainText = content
			.filter((c) => c?.type === "text" && typeof c.text === "string")
			.map((c) => c.text as string)
			.join("\n")
			.trim();
		if (!plainText) return; // nothing to deliver

		// Best-effort send. Don't throw — we don't want to crash the harness
		// if a transient Telegram error happens during cleanup.
		try {
			const token = await tokenFor(botLabel);
			const chunks: string[] = [];
			let s = plainText;
			while (s.length > 4096) {
				chunks.push(s.slice(0, 4096));
				s = s.slice(4096);
			}
			chunks.push(s);
			for (const chunk of chunks) {
				await tgCall(token, "sendMessage", {
					chat_id: chatId,
					text: chunk,
				});
			}
			console.error(
				`[telegram-out] reply-fallback delivered ${plainText.length} chars to bot=${botLabel} chat=${chatId} (Qwen3 forgot to call reply)`,
			);
		} catch (err) {
			console.error(
				`[telegram-out] reply-fallback FAILED: ${(err as Error).message} — message lost`,
			);
		}
	});
}

export default function (pi: ExtensionAPI) {
	pi.registerTool(reply);
	pi.registerTool(react);
	pi.registerTool(editMessage);
	pi.registerTool(downloadAttachment);
	attachReplyFallback(pi);
	process.on("exit", () => {
		void pool.end().catch(() => undefined);
	});
}
