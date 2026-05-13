// Context compaction for long chat threads.
//
// The AI SDK streamText loop replays every previous message on every turn.
// For long-running dashboard sessions (a triage thread that's been alive for
// 50+ turns with screenshots, tool outputs, plane page bodies, etc.) this
// pushes the context window. Even on Qwen3-Turbo's 256k tokens, repeated
// full-context calls eat $$$ and eventually 4xx.
//
// This helper compacts the *head* of a long thread into a dense summary
// (one extra `generateText` call to the same provider as the main turn),
// keeps the *tail* verbatim, and returns both a shortened message list AND
// a system-prompt addendum to splice into the streamText call. The caller
// stays in charge of passing the trimmed messages to convertToModelMessages
// and concatenating the addendum onto its system prompt.
//
// Stateless v1 — no DB persistence. The summary is recomputed each turn
// when the threshold is exceeded. That's an extra ~$0.001 per long turn
// (Qwen3 summarizing ~80k chars → ~600 tokens) and avoids schema migration.
// If the cost stings, the next step is to cache in-memory keyed by
// (thread_id, last_summarized_message_count).

import { generateText } from 'ai';

// Character-count proxy for tokens. Industry rule of thumb is ~4 chars/token
// for English; ~3 chars/token for code & JSON. We use 4 conservatively so
// we trigger compaction a bit early rather than risk hitting the wall.
const COMPACTION_THRESHOLD_CHARS = 200_000; // ≈ 50k tokens
const KEEP_RECENT_MESSAGES = 12;            // ≈ 6 user/assistant turns kept verbatim
const SUMMARY_OUTPUT_CHAR_CAP = 1500;       // truncate the summary itself if model overshoots
const TRANSCRIPT_INPUT_CHAR_CAP = 80_000;   // cap what we send to the summarizer

const SUMMARY_SYSTEM = [
  'You are a chat-history summarizer.',
  'Given a transcript of earlier messages between a user and an AI agent, produce a dense factual summary covering:',
  '- Decisions reached and the reasoning.',
  '- Tools called and the gist of their results (work item IDs, capture IDs, job IDs, status fields).',
  '- Open questions or pending tasks not yet resolved.',
  '- Identities, projects, and any subject IDs the conversation referenced.',
  'Be terse. No commentary, no markdown headers. Output prose, ~1500 characters max.',
].join('\n');

// Estimate the character size of a UIMessage[] (the assistant-ui / AI-SDK shape).
// Handles text parts and best-effort serializes tool input/output objects.
export function estimateMessageChars(messages) {
  let n = 0;
  for (const m of messages || []) {
    if (Array.isArray(m.parts)) {
      for (const p of m.parts) {
        if (typeof p?.text === 'string') n += p.text.length;
        else if (typeof p?.output === 'string') n += p.output.length;
        else if (p?.output != null) n += JSON.stringify(p.output).length;
        else if (p?.input != null) n += JSON.stringify(p.input).length;
      }
    } else if (typeof m.content === 'string') {
      n += m.content.length;
    }
  }
  return n;
}

function messageToTranscriptLine(m) {
  const role = m.role || 'assistant';
  if (!Array.isArray(m.parts)) {
    const text = typeof m.content === 'string' ? m.content : '';
    return text ? `${role}: ${text}` : '';
  }
  const segments = [];
  for (const p of m.parts) {
    if (p?.type === 'text' && typeof p?.text === 'string') {
      segments.push(p.text);
      continue;
    }
    const looksToolish = typeof p?.type === 'string' && p.type.startsWith('tool');
    if (looksToolish) {
      const name = p.toolName || p.tool || (p.type === 'tool' ? 'tool' : p.type);
      let payload;
      if (typeof p.output === 'string') payload = p.output;
      else if (p.output != null) payload = JSON.stringify(p.output);
      else if (p.input != null) payload = JSON.stringify(p.input);
      else if (p.args != null) payload = JSON.stringify(p.args);
      else payload = '';
      segments.push(`[${name}] ${String(payload).slice(0, 600)}`);
    }
  }
  const joined = segments.filter(Boolean).join('\n');
  return joined ? `${role}: ${joined}` : '';
}

// Returns:
//   { messages: <maybeTrimmed>, systemAddendum: string|null, didCompact: bool, ...stats }
// The caller decides what to do with the addendum (typically:
// `system: origSystem + '\n\n' + addendum`).
export async function compactIfNeeded({
  messages,
  model,
  threshold = COMPACTION_THRESHOLD_CHARS,
  keepRecent = KEEP_RECENT_MESSAGES,
} = {}) {
  if (!Array.isArray(messages) || messages.length <= keepRecent) {
    return { messages, systemAddendum: null, didCompact: false };
  }
  const totalChars = estimateMessageChars(messages);
  if (totalChars < threshold) {
    return { messages, systemAddendum: null, didCompact: false };
  }

  const tail = messages.slice(-keepRecent);
  const head = messages.slice(0, -keepRecent);
  if (head.length === 0) {
    return { messages, systemAddendum: null, didCompact: false };
  }

  const transcript = head
    .map(messageToTranscriptLine)
    .filter(Boolean)
    .join('\n\n')
    .slice(0, TRANSCRIPT_INPUT_CHAR_CAP);

  let summary;
  try {
    const { text } = await generateText({
      model,
      system: SUMMARY_SYSTEM,
      prompt: `Summarize the conversation transcript below.\n\n---\n${transcript}\n---`,
    });
    summary = (text || '').trim().slice(0, SUMMARY_OUTPUT_CHAR_CAP);
  } catch (err) {
    // Fail open: if the side LLM call breaks, just send the full context.
    // Better a $$ turn than a broken chat.
    console.warn('[chat-compaction] summary call failed; passing full context:', err.message);
    return { messages, systemAddendum: null, didCompact: false };
  }

  if (!summary) {
    return { messages, systemAddendum: null, didCompact: false };
  }

  const systemAddendum = `[Earlier conversation — ${head.length} messages compacted into a summary; only the most recent turns follow]\n\n${summary}`;
  console.log(`[chat-compaction] compacted ${head.length} msgs (${totalChars} chars → summary ${summary.length} chars)`);
  return {
    messages: tail,
    systemAddendum,
    didCompact: true,
    summarizedCount: head.length,
    summaryChars: summary.length,
    originalChars: totalChars,
  };
}
