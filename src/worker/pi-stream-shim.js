// src/worker/pi-stream-shim.js
//
// Translate Pi (`@earendil-works/pi-coding-agent`) `--mode json` events
// into the same shape `claude -p --output-format stream-json` emits, so the
// worker's existing stream-parser.js + classifyEvent + getFinalResultText
// pipeline stays unchanged.
//
// Pi event vocabulary (from spike on 2026-05-09):
//   session, agent_start, agent_end                    — lifecycle
//   turn_start, turn_end                                — internal
//   message_start, message_update, message_end          — message envelope
//   tool_execution_start, tool_execution_update, tool_execution_end
//
// Inside `message_update.assistantMessageEvent.type` we have:
//   text_start, text_delta, text_end, toolcall_start, toolcall_delta, toolcall_end
//
// We don't need delta-level granularity — the worker only persists events for
// the dashboard timeline and extracts the final result text. So the strategy:
//   1. Emit a `system/init` synthesized event when `session` lands.
//   2. Emit one `assistant` event per `message_end` whose role=assistant,
//      reshaping pi's content blocks (`text` and `toolCall`) to claude's
//      (`text` and `tool_use`).
//   3. Emit one `user/tool_result` event per `tool_execution_end`.
//   4. Emit a final `result/success` event when `agent_end` lands, carrying
//      the parseResult-shaped JSON the worker wants. Caller is responsible
//      for extracting that JSON from the last assistant message's text and
//      passing it in via `finalResultText`.
//
// All other Pi events are dropped — they're either internal turn machinery
// or redundant streaming snapshots that the worker doesn't need to persist.
//
// Pi tool ids are like `call_5ae8596bbfe6d322`; we keep them verbatim as
// claude's `tool_use.id` so tool_use ↔ tool_result correlation works.

export function createPiStreamShim({ onTranslatedEvent }) {
  // Track tool_use ids we've emitted so tool_result events can correlate.
  // Currently used only for sanity logging — stream-parser doesn't care.
  const seenToolCallIds = new Set();
  let totalUsage = null; // last assistant message's cumulative usage

  function emit(translated) {
    onTranslatedEvent(translated);
  }

  // Reshape pi's assistant message content to claude's. Pi uses:
  //   { type: "text", text }
  //   { type: "toolCall", id, name, arguments }
  // Claude uses:
  //   { type: "text", text }
  //   { type: "tool_use", id, name, input }
  function reshapeContent(piContent) {
    return (piContent || []).map((block) => {
      if (block?.type === 'text') {
        return { type: 'text', text: block.text || '' };
      }
      if (block?.type === 'toolCall') {
        seenToolCallIds.add(block.id);
        return {
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: block.arguments || {}
        };
      }
      // Unknown content shape — pass through best-effort so we don't lose data.
      return block;
    });
  }

  function handle(event) {
    if (!event || typeof event !== 'object') return;
    const t = event.type;

    if (t === 'session') {
      emit({
        type: 'system',
        subtype: 'init',
        session_id: event.id,
        cwd: event.cwd,
        version: event.version,
        harness: 'pi'
      });
      return;
    }

    if (t === 'message_end') {
      const msg = event.message || {};
      const role = msg.role;
      if (role === 'assistant') {
        // Accumulate the latest cumulative usage snapshot.
        if (msg.usage) totalUsage = msg.usage;
        emit({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: reshapeContent(msg.content),
            // Carry pi metadata for the dashboard but don't break claude's shape.
            model: msg.model,
            provider: msg.provider,
            usage: msg.usage,
            stop_reason: msg.stopReason
          }
        });
      } else if (role === 'user') {
        // User-initiated message_end — typically the prompt, not a tool result.
        // Tool results come through tool_execution_end below. We still emit
        // for dashboard fidelity.
        emit({
          type: 'user',
          message: {
            role: 'user',
            content: reshapeContent(msg.content)
          }
        });
      }
      // 'toolResult' role messages are duplicates of tool_execution_end —
      // skip to avoid double-counting in the timeline.
      return;
    }

    if (t === 'tool_execution_end') {
      // Pi emits this top-level when a tool completes. Map to claude's
      // tool_result content block carried inside a user message.
      const toolCallId = event.toolCallId;
      const isError = !!event.isError;
      // Pi gives us a pre-shaped { content: [...] } object. claude expects
      // either a string or an array of content blocks under tool_result.content.
      const piContent = event.result?.content || [];
      const content = piContent.length === 1 && piContent[0]?.type === 'text'
        ? piContent[0].text
        : piContent;
      emit({
        type: 'user',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: toolCallId,
            content,
            is_error: isError
          }]
        }
      });
      return;
    }

    if (t === 'agent_end') {
      // Final result — caller passes the result JSON text in via
      // finalize() below; we just synthesize the envelope here in case
      // finalize was never called (defensive fallback).
      const messages = event.messages || [];
      const lastAssistant = [...messages].reverse().find(m => m?.role === 'assistant');
      const finalText = (lastAssistant?.content || [])
        .filter(c => c?.type === 'text')
        .map(c => c.text)
        .join('\n');
      emit({
        type: 'result',
        subtype: 'success',
        result: finalText,
        usage: totalUsage,
        harness: 'pi'
      });
      return;
    }

    // All other event types (agent_start, turn_*, message_start,
    // message_update, tool_execution_start/update) are dropped intentionally.
  }

  return {
    handle,
    // Emit a synthetic error/result event when the spawn fails before
    // agent_end landed (non-zero exit, stderr noise, etc).
    emitError(reason) {
      emit({
        type: 'result',
        subtype: 'error_pi',
        result: String(reason || 'pi spawn failed'),
        harness: 'pi'
      });
    },
    getTotalUsage() { return totalUsage; }
  };
}

// Convenience: parse one line of pi --mode json stdout into a JS object.
// Returns null on parse failure (caller logs).
export function parsePiLine(line) {
  const trimmed = (line || '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}
