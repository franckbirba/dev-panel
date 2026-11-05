import { CliProcessDriver } from './cli-process-driver.js';

function summarize(value) {
  return typeof value === 'string' ? value : JSON.stringify(value ?? {});
}

export class OpenCodeCliDriver extends CliProcessDriver {
  constructor({ spawnImpl, opencodeBin = 'opencode', onEvent } = {}) {
    super({ spawnImpl, onEvent });
    this.opencodeBin = opencodeBin;
    this.driverName = 'opencode-cli';
    this.displayName = 'OpenCode CLI';
  }

  buildInvocation(prompt, nativeSessionId) {
    const args = ['run', '--standalone'];
    if (nativeSessionId) args.push('--session', nativeSessionId);
    args.push(prompt, '--format', 'json');
    return { command: this.opencodeBin, args };
  }

  handleNativeEvent(native, trimmed, emit, handle) {
    if (native.sessionID && !handle.native_session_id) {
      handle.native_session_id = native.sessionID;
    }

    if (native.type === 'step_start') return;

    if (native.type === 'text' && native.part?.text) {
      emit('stdout', { content: native.part.text, truncated: false });
      return;
    }

    if (native.type === 'tool_use') {
      const part = native.part || {};
      const state = part.state || {};
      const callId = part.callID || part.id || part.partID || native.id;
      const status = state.status || part.status || 'running';
      const calls = handle.opencodeToolCalls || new Map();
      const previous = calls.get(callId) || {};
      handle.opencodeToolCalls = calls;

      if (!previous.started) {
        emit('tool_started', {
          tool_call_id: callId,
          tool_name: part.tool || native.tool || 'unknown',
          input_summary: summarize(state.input ?? part.input)
        });
        previous.started = true;
      }

      if (['completed', 'error', 'failed'].includes(status) && !previous.finished) {
        emit('tool_finished', {
          tool_call_id: callId,
          status: status === 'completed' ? 'completed' : 'failed',
          output_summary: summarize(state.error ?? state.output ?? part.output)
        });
        previous.finished = true;
      }

      calls.set(callId, previous);
      return;
    }

    if (native.type === 'tool_result') {
      emit('tool_finished', {
        tool_call_id: native.part?.tool_call_id || native.part?.callID || native.part?.id || native.id,
        status: native.part?.is_error ? 'failed' : 'completed',
        output_summary: summarize(native.part?.output)
      });
      return;
    }

    if (!['step_finish', 'step-start'].includes(native.type)) {
      emit('stdout', { content: trimmed, truncated: false });
    }
  }
}
