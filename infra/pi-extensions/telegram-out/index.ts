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
	description:
		"Send a Telegram message. Pass bot_label and chat_id from the inbound <channel> tag. Optional reply_to (message_id) for threading. Telegram caps a single message at 4096 chars; over that, the tool splits and sends multiple messages.",
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
	description:
		"Add an emoji reaction to a message. Telegram only allows a small whitelist of emojis as reactions — see Bot API docs.",
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
	description:
		"Edit the text of a previously-sent message. Only messages the bot itself sent can be edited.",
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
	description:
		"Fetch a Telegram file attachment by file_id and save it to the local inbox. Returns the absolute path; the caller should Read it. Telegram caps bot downloads at 20MB.",
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

export default function (pi: ExtensionAPI) {
	pi.registerTool(reply);
	pi.registerTool(react);
	pi.registerTool(editMessage);
	pi.registerTool(downloadAttachment);
	process.on("exit", () => {
		void pool.end().catch(() => undefined);
	});
}
