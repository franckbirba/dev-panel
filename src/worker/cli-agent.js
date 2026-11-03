import { spawn } from 'child_process';
import { ClaudeCodeCliDriver } from './claude-code-cli-driver.js';
import { KimiCodeCliDriver } from './kimi-code-cli-driver.js';
import { appendEvent as defaultAppendEvent } from '../server/jobs-events.js';

const DRIVER_FACTORIES = {
  'claude-code-cli': options => new ClaudeCodeCliDriver(options),
  'kimi-code-cli': options => new KimiCodeCliDriver(options)
};

export function spawnCliAgent({
  driverName,
  jobId,
  prompt,
  cwd,
  activeProcesses,
  appendEvent = defaultAppendEvent,
  spawnImpl = spawn
}) {
  const createDriver = DRIVER_FACTORIES[driverName];
  if (!createDriver) {
    return Promise.reject(new Error(`Unsupported CLI driver: ${driverName}`));
  }

  const driver = createDriver({
    spawnImpl,
    onEvent: event => {
      if (event.type === 'stdout') finalText = event.payload.content || finalText;
      Promise.resolve(appendEvent({
        job_id: String(jobId),
        seq: event.sequence,
        event_type: event.type,
        event_subtype: null,
        payload: event.payload
      })).catch(error => console.error(`[cli-agent] appendEvent failed: ${error.message}`));
    }
  });

  const handle = driver.start({
    run_id: String(jobId),
    worktree: { path: cwd }
  }, prompt);

  activeProcesses.set(String(jobId), {
    process: handle.process,
    startedAt: Date.now(),
    driver: driverName
  });

  let finalText = '';
  return new Promise((resolve, reject) => {
    handle.resolveCancel = () => resolve(finalText);
    handle.process.on('close', code => {
      activeProcesses.delete(String(jobId));
      if (code === 0) {
        resolve(finalText);
      } else {
        reject(new Error(`${handle.displayName} exited with code ${code}`));
      }
    });
    handle.process.on('error', error => {
      activeProcesses.delete(String(jobId));
      reject(error);
    });
  });
}
