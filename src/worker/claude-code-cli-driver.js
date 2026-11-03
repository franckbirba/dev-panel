import { CliProcessDriver } from './cli-process-driver.js';

export class ClaudeCodeCliDriver extends CliProcessDriver {
  constructor({ spawnImpl, claudeBin = 'claude', onEvent } = {}) {
    super({ spawnImpl, onEvent });
    this.claudeBin = claudeBin;
    this.driverName = 'claude-code-cli';
    this.displayName = 'Claude Code CLI';
  }

  buildInvocation(prompt) {
    return {
      command: this.claudeBin,
      args: ['-p', prompt, '--output-format', 'stream-json', '--verbose']
    };
  }

  handleNativeEvent(native, trimmed, emit, handle) {
    if (native.type === 'system' && native.session_id) {
      handle.native_session_id = native.session_id;
      return;
    }

    if (native.type === 'assistant') {
      for (const part of native.message?.content || []) {
        if (part.type === 'text' && part.text) {
          emit('stdout', { content: part.text, truncated: false });
        } else if (part.type === 'tool_use') {
          emit('tool_started', {
            tool_call_id: part.id,
            tool_name: part.name,
            input_summary: JSON.stringify(part.input || {})
          });
        }
      }
      return;
    }

    if (native.type === 'user') {
      for (const part of native.message?.content || []) {
        if (part.type === 'tool_result') {
          emit('tool_finished', {
            tool_call_id: part.tool_use_id,
            status: part.is_error ? 'failed' : 'completed',
            output_summary: typeof part.content === 'string' ? part.content : JSON.stringify(part.content || {})
          });
        }
      }
      return;
    }

    if (!['result', 'system'].includes(native.type)) {
      emit('stdout', { content: trimmed, truncated: false });
    }
  }
}
