import { CliProcessDriver } from './cli-process-driver.js';

export class KimiCodeCliDriver extends CliProcessDriver {
  constructor({ spawnImpl, kimiBin = 'kimi', onEvent } = {}) {
    super({ spawnImpl, onEvent });
    this.kimiBin = kimiBin;
    this.driverName = 'kimi-code-cli';
    this.displayName = 'Kimi Code CLI';
  }

  buildInvocation(prompt, nativeSessionId) {
    const args = [];
    if (nativeSessionId) args.push('--session', nativeSessionId);
    args.push('-p', prompt, '--output-format', 'stream-json');
    return { command: this.kimiBin, args };
  }

  handleNativeEvent(native, trimmed, emit) {
    if (native.role === 'assistant' && typeof native.content === 'string') {
      emit('stdout', { content: native.content, truncated: false });
    } else if (native.role !== 'meta') {
      emit('stdout', { content: trimmed, truncated: false });
    }
  }
}
