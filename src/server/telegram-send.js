// telegram-send.js
// Thin wrappers around Telegram Bot API used by both the autoroute (DM the
// resolved dev) and the capture broadcast (Franck's observability chat).
// Kept dependency-free so unit tests can mock global.fetch.

const TG_API = 'https://api.telegram.org';
// Telegram caps photo captions at 1024 chars; stay well under to leave room
// for tag prefix + URL when callers concatenate metadata.
export const TG_CAPTION_MAX = 1000;

export async function sendDirect({ token, chat_id, text }) {
  const r = await fetch(`${TG_API}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id, text })
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`telegram sendMessage ${r.status}: ${body}`);
  }
}

// Multipart upload of a base64 data URL. Telegram's `photo` field doesn't
// accept data: URLs — has to be a file_id, http(s) URL, or multipart.
export async function sendPhoto({ token, chat_id, dataUrl, caption }) {
  const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!m) throw new Error('screenshot is not a base64 data URL');
  const mime = m[1];
  const buf = Buffer.from(m[2], 'base64');
  const ext = mime === 'image/jpeg' ? 'jpg' : (mime.split('/')[1] || 'png');
  const fd = new FormData();
  fd.append('chat_id', String(chat_id));
  if (caption) fd.append('caption', caption.slice(0, TG_CAPTION_MAX));
  fd.append('photo', new Blob([buf], { type: mime }), `capture.${ext}`);
  const r = await fetch(`${TG_API}/bot${token}/sendPhoto`, { method: 'POST', body: fd });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`telegram sendPhoto ${r.status}: ${body}`);
  }
}
