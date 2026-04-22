// Parser for `claude -p --output-format stream-json` stdout.
//
// Each line is a JSON object describing one event in the agent's run:
// system (init), user, assistant (text or tool_use), tool_result, result (final).
// We buffer partial lines across chunks, JSON.parse each complete line, and
// hand events to a consumer. Malformed JSON is logged but not fatal — if
// one line breaks we keep reading.
//
// The final `result` event carries the structured JSON the agent returns;
// getFinalResultText() extracts it so parseResult() in prompt-builder.js
// can still validate the schema.

export function createStreamParser(onEvent) {
  let buffer = '';
  let seq = 0;
  let malformed = 0;

  return {
    push(chunk) {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          const event = JSON.parse(line);
          onEvent({ seq: seq++, event });
        } catch (err) {
          malformed++;
          console.warn(`[stream-parser] malformed line (seq=${seq}): ${err.message}`);
          seq++; // keep seq monotonic so events line up with UI
        }
      }
    },
    flush() {
      const tail = buffer.trim();
      buffer = '';
      if (!tail) return;
      try {
        onEvent({ seq: seq++, event: JSON.parse(tail) });
      } catch (err) {
        malformed++;
        console.warn(`[stream-parser] malformed trailing line: ${err.message}`);
      }
    },
    stats() {
      return { total: seq, malformed };
    }
  };
}

// stream-json events look like:
//   { type: "system", subtype: "init", ... }
//   { type: "user",   message: { role: "user", content: [...] } }
//   { type: "assistant", message: { role: "assistant", content: [ { type: "text", text } | { type: "tool_use", ... } ] } }
//   { type: "user",   message: { role: "user", content: [ { type: "tool_result", ... } ] } }
//   { type: "result", subtype: "success"|"error_*", result: "<stringified text>" | ... }
//
// Extract the human-readable/JSON text from the final result.result field —
// this is where the agent's summary JSON lives and what parseResult() needs.
export function getFinalResultText(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.type === 'result') {
      if (typeof e.result === 'string') return e.result;
      // Some versions wrap it. Fall back to JSON-stringifying the whole event.
      return typeof e.result === 'object' ? JSON.stringify(e.result) : '';
    }
  }
  return '';
}

// Classify an event into a compact (type, subtype) pair used by the UI + DB.
// Stored in agent_job_events.event_type / event_subtype.
// Matches the bucket names the dashboard's EventCard renders: system,
// assistant, tool_use, tool_result, result, unknown.
export function classifyEvent(event) {
  const type = event?.type || 'unknown';
  if (type === 'system') return { event_type: 'system', event_subtype: event.subtype || null };
  if (type === 'result') return { event_type: 'result', event_subtype: event.subtype || null };
  if (type === 'assistant') {
    const parts = event?.message?.content || [];
    if (parts.some(p => p?.type === 'tool_use')) return { event_type: 'tool_use', event_subtype: null };
    return { event_type: 'assistant', event_subtype: null };
  }
  if (type === 'user') {
    const parts = event?.message?.content || [];
    if (parts.some(p => p?.type === 'tool_result')) return { event_type: 'tool_result', event_subtype: null };
    return { event_type: 'user', event_subtype: null };
  }
  return { event_type: type, event_subtype: null };
}
