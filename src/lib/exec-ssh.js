// src/lib/exec-ssh.js
//
// LA copie canonique de execSsh — remplace les 4 copies locales qui
// crashaient devpanel-api : sans handler `child.on('error')`, un spawn qui
// échoue (binaire ssh absent du container) émet un événement 'error' sans
// listener → exception non capturée → le process Express meurt (constaté
// 3/3 à l'audit du 2026-08-18). Contrat : cette fonction ne rejette JAMAIS.
//
// exitCode conventions: 0..255 = exit réel · -1 = timeout · -2 = spawn error.
import { spawn } from 'node:child_process';

export function execSsh(target, command, { timeoutMs = 15_000, sshBin = 'ssh' } = {}) {
  return new Promise((resolve) => {
    const start = Date.now();
    let settled = false;
    let timer;
    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ durationMs: Date.now() - start, ...result });
    };

    if (process.env.DEVPANEL_SSH_TOOLS === 'off') {
      return done({
        stdout: '',
        stderr: 'SSH tools désactivés sur ce mount (devpanel-api n\'a ni ssh ni clés — invariant ADR-003). '
          + 'Utilise le canal worker, ou le mount stdio agents-host.',
        exitCode: -3,
      });
    }

    let child;
    try {
      child = spawn(sshBin, [
        '-o', 'BatchMode=yes',
        '-o', 'ConnectTimeout=5',
        '-o', 'StrictHostKeyChecking=accept-new',
        target,
        command,
      ]);
    } catch (err) {
      return done({ stdout: '', stderr: String(err), exitCode: -2 });
    }

    let stdout = '';
    let stderr = '';
    timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch { /* already dead */ }
      done({ stdout, stderr: stderr + '\n[timeout]', exitCode: -1 });
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => {
      done({ stdout, stderr: stderr + String(err), exitCode: -2 });
    });
    child.on('close', (code) => {
      done({ stdout, stderr, exitCode: code ?? 0 });
    });
  });
}
