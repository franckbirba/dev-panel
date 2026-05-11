// Qwen3-Coder (and other Hermes-format tool-callers) sometimes emit their
// native `<tool_call>{…}</tool_call>` markup inline with the text channel,
// in addition to the structured `tool_calls` field that DeepInfra's
// OpenAI-compat layer parses. When that happens, the closing fragment
// (`function> </tool_call>` is a common one) leaks into the rendered
// assistant message. Strip it on the text-delta stream before it reaches
// the data-stream encoder. Pass via `experimental_transform` on streamText.
//
// Kept in its own module (no provider imports) so it's unit-testable
// without dragging in @ai-sdk/openai.

const TOOL_CALL_FULL = /<tool_call>[\s\S]*?<\/tool_call>/g;
const TOOL_CALL_DANGLING_CLOSE = /(?:function\s*>\s*)?<\/tool_call>/g;
const TOOL_CALL_DANGLING_OPEN_TAIL = /<tool_call>[\s\S]*$/;
const OPEN_TAG = '<tool_call>';

// Find the start index of the longest suffix of `s` that is a strict prefix
// of `<tool_call>` (e.g. trailing `<tool_` should be buffered, not emitted).
// Returns -1 when no such suffix exists.
function findOpenPrefixStart(s) {
  const maxLen = Math.min(s.length, OPEN_TAG.length - 1);
  for (let len = maxLen; len > 0; len--) {
    if (OPEN_TAG.startsWith(s.slice(s.length - len))) {
      return s.length - len;
    }
  }
  return -1;
}

export function makeTextScrubber() {
  let pending = '';
  return new TransformStream({
    transform(part, controller) {
      if (part?.type !== 'text-delta' || typeof part.text !== 'string') {
        controller.enqueue(part);
        return;
      }
      const combined = pending + part.text;
      let scrubbed = combined
        .replace(TOOL_CALL_FULL, '')
        .replace(TOOL_CALL_DANGLING_CLOSE, '');
      // If a complete opening `<tool_call>` arrived but its closer hasn't,
      // hold the entire tail back until the next chunk completes the tag.
      const openIdx = scrubbed.search(TOOL_CALL_DANGLING_OPEN_TAIL);
      if (openIdx >= 0) {
        pending = scrubbed.slice(openIdx);
        scrubbed = scrubbed.slice(0, openIdx);
      } else {
        // Otherwise, if the chunk ends with a *partial* prefix of
        // `<tool_call>` (e.g. `<tool_`), buffer that tail too — the rest
        // of the tag may land in the next delta.
        const prefixIdx = findOpenPrefixStart(scrubbed);
        if (prefixIdx >= 0) {
          pending = scrubbed.slice(prefixIdx);
          scrubbed = scrubbed.slice(0, prefixIdx);
        } else {
          pending = '';
        }
      }
      if (scrubbed.length > 0) {
        controller.enqueue({ ...part, text: scrubbed });
      }
    },
    flush() {
      // On stream end, drop any leftover open-tag tail — by definition the
      // closing tag never arrived, so it was always garbage. A genuine
      // partial-prefix that never resolved to a full tag is also dropped:
      // emitting it would just be a stray `<tool_` artifact.
      pending = '';
    },
  });
}
