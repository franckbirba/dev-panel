import { CliProcessDriver } from './cli-process-driver.js';

export class OpenCodeCliDriver extends CliProcessDriver {
  constructor({ spawnImpl, opencodeBin = 'opencode', onEvent } = {}) {
    super({ spawnImpl, onEvent });
    this.opencodeBin = opencodeBin;
    this.driverName = 'opencode-cli';
    this.displayName = 'OpenCode CLI';
  }

  buildInvocation(prompt) {
    return {
      command: this.opencodeBin,
      args: ['run', prompt, '--format', 'json']
    };
  }

  handleNativeEvent(native, trimmed, emit, handle) {
    if (native.type === 'step_start' && native.sessionID) {
      handle.native_session_id = native.sessionID;
      return;
    }

    if (native.type === 'text' && native.part?.text) {
      emit('stdout', { content: native.part.text, truncated: false });
      return;
    }

    if (native.type === 'tool_use') {
      emit('tool_started', {
        tool_call_id: native.part?.id || native.id,
        tool_name: native.part?.tool || native.tool || 'unknown',
        input_summary: JSON.stringify(native.part?.input || {})
      });
      return;
    }

    if (native.type === 'tool_result') {
      emit('tool_finished', {
        tool_call_id: native.part?.tool_call_id || native.part?.id || native.id,
        status: native.part?.is_error ? 'failed' : 'completed',
        output_summary: typeof native.part?.output === 'string'
          ? native.part.output
          : JSON.stringify(native.part?.output || {})
      });
      return;
    }

    if (!['step_finish', 'step-start'].includes(native.type)) {
      emit('stdout', { content: trimmed, truncated: false });
    }
  }
}
