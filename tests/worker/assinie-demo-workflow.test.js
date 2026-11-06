import { describe, it, expect } from 'vitest';
import { loadWorkflows } from '../../src/worker/engine.js';

const flow = loadWorkflows()['assinie-demo'];

describe('assinie-demo workflow', () => {
  it('loads with bounded revisions', () => {
    expect(flow.max_revisions).toBe(3);
    expect(flow.on_exhaustion).toBe('block');
  });

  it('declares every agent and a valid success path', () => {
    expect(flow.steps.map(step => step.agent)).toEqual([
      'builder', 'cybersecurity', 'ops', 'full-stack', 'reviewer', 'qa'
    ]);
    expect(flow.steps[0].on.done.next).toBe('cybersecurity');
    expect(flow.steps[1].on.done.next).toBe('ops');
    expect(flow.steps[2].on.done.next).toBe('full-stack');
    expect(flow.steps[3].on.done.next).toBe('reviewer');
    expect(flow.steps[4].on.done.next).toBe('qa');
    expect(flow.steps[5].on.done.terminal).toBe(true);
  });

  it('retreats failures to a declared producer without an unbounded loop', () => {
    expect(flow.steps[1].on.failed).toEqual({ next: 'builder', when: 'security_issues_found' });
    expect(flow.steps[2].on.failed).toEqual({ next: 'cybersecurity', when: 'ops_issues_found' });
    expect(flow.steps[3].on.failed).toEqual({ next: 'ops', when: 'implementation_issues_found' });
    expect(flow.steps[4].on.failed).toEqual({ next: 'full-stack', when: 'reviewer_rejected_pr' });
    expect(flow.steps[5].on.failed).toEqual({ next: 'pm', workflow: 'replan' });
  });
});
