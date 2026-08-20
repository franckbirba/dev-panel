// tests/worker/process-timeout-controller.test.js
//
// Engine contract §5 — stall detection + wall-clock kill, process-group
// SIGTERM→grace→SIGKILL. Uses vitest fake timers and a fake process; no
// real child_process spawn required.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { createProcessTimeoutController } from '../../src/worker/process-timeout-controller.js';

function fakeProcess(pid = 4242) {
  const emitter = new EventEmitter();
  return {
    pid,
    kill: vi.fn(),
    once: (event, cb) => emitter.once(event, cb),
    _emitExit: () => emitter.emit('exit'),
  };
}

describe('process-timeout-controller', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires stall kill after stallMs with no recordEvent() calls', () => {
    const proc = fakeProcess();
    const killGroupFn = vi.fn();
    const onKill = vi.fn();
    createProcessTimeoutController({
      proc,
      wallClockMs: 60 * 60 * 1000, // wall clock far away
      stallMs: 5000,
      graceMs: 1000,
      onKill,
      killGroupFn,
    });

    vi.advanceTimersByTime(5000 + 1250); // stall window + one poll tick
    expect(onKill).toHaveBeenCalledWith({ reason: 'stall' });
    expect(killGroupFn).toHaveBeenCalledWith(proc.pid, 'SIGTERM');
  });

  it('recordEvent() resets the stall window', () => {
    const proc = fakeProcess();
    const killGroupFn = vi.fn();
    const onKill = vi.fn();
    const ctl = createProcessTimeoutController({
      proc,
      wallClockMs: 60 * 60 * 1000,
      stallMs: 5000,
      graceMs: 1000,
      onKill,
      killGroupFn,
    });

    // Advance almost to the stall boundary, then record an event.
    vi.advanceTimersByTime(4000);
    ctl.recordEvent();
    vi.advanceTimersByTime(4000);
    ctl.recordEvent();
    vi.advanceTimersByTime(4000);
    expect(onKill).not.toHaveBeenCalled();

    // Now let it actually go stale.
    vi.advanceTimersByTime(6000);
    expect(onKill).toHaveBeenCalledWith({ reason: 'stall' });
  });

  it('fires wall_clock kill after wallClockMs even with continuous events', () => {
    const proc = fakeProcess();
    const killGroupFn = vi.fn();
    const onKill = vi.fn();
    const ctl = createProcessTimeoutController({
      proc,
      wallClockMs: 10000,
      stallMs: 100000, // never stalls
      graceMs: 1000,
      onKill,
      killGroupFn,
    });

    // Keep "recording events" so it never stalls.
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(1500);
      ctl.recordEvent();
    }
    expect(onKill).not.toHaveBeenCalled();

    vi.advanceTimersByTime(4000);
    expect(onKill).toHaveBeenCalledWith({ reason: 'wall_clock' });
    expect(killGroupFn).toHaveBeenCalledWith(proc.pid, 'SIGTERM');
  });

  it('escalates to SIGKILL after graceMs if the process has not exited', () => {
    const proc = fakeProcess();
    const killGroupFn = vi.fn();
    createProcessTimeoutController({
      proc,
      wallClockMs: 1000,
      stallMs: 100000,
      graceMs: 2000,
      killGroupFn,
    });

    vi.advanceTimersByTime(1000); // trigger wall-clock kill -> SIGTERM
    expect(killGroupFn).toHaveBeenCalledWith(proc.pid, 'SIGTERM');
    expect(killGroupFn).not.toHaveBeenCalledWith(proc.pid, 'SIGKILL');

    vi.advanceTimersByTime(2000); // grace elapses without exit
    expect(killGroupFn).toHaveBeenCalledWith(proc.pid, 'SIGKILL');
  });

  it('does NOT escalate to SIGKILL if the process exits during the grace period', () => {
    const proc = fakeProcess();
    const killGroupFn = vi.fn();
    createProcessTimeoutController({
      proc,
      wallClockMs: 1000,
      stallMs: 100000,
      graceMs: 2000,
      killGroupFn,
    });

    vi.advanceTimersByTime(1000); // SIGTERM fires
    proc._emitExit(); // process exits cleanly
    vi.advanceTimersByTime(2000); // grace period elapses
    expect(killGroupFn).not.toHaveBeenCalledWith(proc.pid, 'SIGKILL');
  });

  it('stop() disarms both timers so a normal completion never triggers a kill', () => {
    const proc = fakeProcess();
    const killGroupFn = vi.fn();
    const onKill = vi.fn();
    const ctl = createProcessTimeoutController({
      proc,
      wallClockMs: 5000,
      stallMs: 5000,
      graceMs: 1000,
      onKill,
      killGroupFn,
    });

    vi.advanceTimersByTime(2000);
    ctl.stop();
    vi.advanceTimersByTime(10000);
    expect(onKill).not.toHaveBeenCalled();
    expect(killGroupFn).not.toHaveBeenCalled();
  });

  it('onKill fires exactly once even if both stall and wall-clock could theoretically race', () => {
    const proc = fakeProcess();
    const killGroupFn = vi.fn();
    const onKill = vi.fn();
    createProcessTimeoutController({
      proc,
      wallClockMs: 5000,
      stallMs: 5000,
      graceMs: 1000,
      onKill,
      killGroupFn,
    });

    vi.advanceTimersByTime(5000 + 1250);
    expect(onKill).toHaveBeenCalledTimes(1);
  });

  it('isKilled() reflects whether a kill has been initiated', () => {
    const proc = fakeProcess();
    const ctl = createProcessTimeoutController({
      proc,
      wallClockMs: 3000,
      stallMs: 100000,
      graceMs: 1000,
      killGroupFn: vi.fn(),
    });
    expect(ctl.isKilled()).toBe(false);
    vi.advanceTimersByTime(3000);
    expect(ctl.isKilled()).toBe(true);
  });

  it('kills the whole process group by default (negative pid)', () => {
    const proc = fakeProcess(9999);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {});
    createProcessTimeoutController({
      proc,
      wallClockMs: 1000,
      stallMs: 100000,
      graceMs: 500,
    });
    vi.advanceTimersByTime(1000);
    expect(killSpy).toHaveBeenCalledWith(-9999, 'SIGTERM');
    killSpy.mockRestore();
  });
});
