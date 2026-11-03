import { spawn } from 'child_process';
import { randomUUID, createHash } from 'crypto';
import { appendFileSync, mkdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { ExecutionAdapter } from './execution-adapter.js';

export class KimiCodeCliDriver extends ExecutionAdapter {
  constructor({ spawnImpl = spawn, kimiBin = 'kimi', onEvent = () => {} } = {}) {
    super();
    this.spawnImpl = spawnImpl;
    this.kimiBin = kimiBin;
    this.onEvent = onEvent;
  }

  capabilities() {
    return ['process', 'stream', 'resume', 'cancel', 'export'];
  }

  start(runSpec, prompt, { nativeSessionId = null } = {}) {
    return this._start(runSpec, prompt, { nativeSessionId });
  }

  resume(runSpec, prompt, { nativeSessionId, decision }) {
    if (!nativeSessionId) throw new Error('nativeSessionId is required to resume a Kimi session');
    if (!decision) throw new Error('decision is required to resume a run');
    return this._start(runSpec, prompt, { nativeSessionId, decision });
  }

  cancel(handle, { reason = 'cancel_requested', cancelled_by = 'devpanel' } = {}) {
    if (handle.status !== 'running') return Promise.resolve(handle);
    handle.cancelling = { reason, cancelled_by };
    handle.process.kill();
    return new Promise(resolve => {
      handle.resolveCancel = () => resolve(handle);
    });
  }

  export(handle) {
    return {
      run_id: handle.run_id,
      driver: handle.driver,
      native_session_id: handle.native_session_id,
      status: handle.status,
      artifacts: handle.artifacts
    };
  }

  _start(runSpec, prompt, { nativeSessionId, decision = null }) {
    if (!runSpec?.run_id) throw new Error('runSpec.run_id is required');
    if (!prompt) throw new Error('prompt is required');
    if (!runSpec.worktree?.path) throw new Error('runSpec.worktree.path is required');

    const args = [];
    if (nativeSessionId) args.push('--session', nativeSessionId);
    args.push('-p', prompt, '--output-format', 'stream-json');

    const process = this.spawnImpl(this.kimiBin, args, {
      cwd: runSpec.worktree.path,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const runDir = join(runSpec.worktree.path, '.devpanel', 'runs', runSpec.run_id);
    mkdirSync(runDir, { recursive: true });
    const eventLogPath = join(runDir, 'events.jsonl');

    const handle = {
      process,
      run_id: runSpec.run_id,
      driver: 'kimi-code-cli',
      native_session_id: nativeSessionId,
      status: 'running',
      artifacts: [],
      eventLogPath,
      sequence: 0,
      cancelling: null,
      resolveCancel: null
    };

    const emit = (type, payload) => {
      const event = {
        schema_version: '1.0',
        event_id: randomUUID(),
        run_id: runSpec.run_id,
        sequence: ++handle.sequence,
        timestamp: new Date().toISOString(),
        type,
        payload
      };
      appendFileSync(eventLogPath, `${JSON.stringify(event)}\n`);
      this.onEvent(event);
    };

    if (decision) {
      emit('resumed', decision);
    } else {
      emit('started', {
        driver: 'kimi-code-cli',
        process_id: process.pid,
        native_session_id: nativeSessionId
      });
    }

    let stdoutBuffer = '';
    let stderrBuffer = '';

    const consume = (chunk, stream) => {
      let buffer = (stream === 'stdout' ? stdoutBuffer : stderrBuffer) + chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop();
      if (stream === 'stdout') stdoutBuffer = buffer;
      else stderrBuffer = buffer;

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (stream === 'stderr') {
          emit('stderr', { content: trimmed, truncated: false });
          continue;
        }

        try {
          const native = JSON.parse(trimmed);
          if (native.type === 'session.resume_hint' && native.session_id) {
            handle.native_session_id = native.session_id;
          } else if (native.role === 'assistant' && typeof native.content === 'string') {
            emit('stdout', { content: native.content, truncated: false });
          } else if (native.role !== 'meta') {
            emit('stdout', { content: trimmed, truncated: false });
          }
        } catch {
          emit('stderr', { content: trimmed, truncated: false });
        }
      }
    };

    process.stdout.on('data', chunk => consume(chunk, 'stdout'));
    process.stderr.on('data', chunk => consume(chunk, 'stderr'));
    process.on('error', error => {
      handle.status = 'failed';
      emit('failed', {
        error_code: 'process_start_failed',
        message: error.message,
        retryable: true
      });
    });
    process.on('close', code => {
      consume('\n', 'stdout');
      consume('\n', 'stderr');
      if (handle.cancelling) {
        handle.status = 'cancelled';
        emit('cancelled', handle.cancelling);
        handle.resolveCancel?.();
        return;
      }

      if (code === 0) {
        const content = readFileSync(eventLogPath);
        const artifact = {
          path: eventLogPath,
          artifact_ref: pathToFileURL(eventLogPath).href,
          kind: 'session-export',
          mime_type: 'application/x-ndjson',
          size_bytes: statSync(eventLogPath).size,
          sha256: createHash('sha256').update(content).digest('hex')
        };
        handle.artifacts.push(artifact);
        handle.status = 'completed';
        emit('artifact_created', artifact);
        emit('completed', {
          summary: 'Kimi Code CLI run completed',
          artifacts: [artifact]
        });
      } else {
        handle.status = 'failed';
        emit('failed', {
          error_code: 'process_exit_nonzero',
          message: `Kimi Code CLI exited with code ${code}`,
          retryable: false
        });
      }
    });

    return handle;
  }
}
