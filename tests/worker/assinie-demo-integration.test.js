// tests/worker/assinie-demo-integration.test.js
import { describe, it, expect } from 'vitest';
import { loadWorkflows } from '../../src/worker/engine.js';

describe('assinie-demo workflow integration', () => {
  it('loads the assinie-demo workflow without errors', () => {
    const flows = loadWorkflows();
    expect(flows).toHaveProperty('assinie-demo');
    
    const workflow = flows['assinie-demo'];
    expect(workflow.name).toBe('assinie-demo');
    expect(workflow.steps).toHaveLength(6);
    expect(workflow.steps.map(s => s.agent)).toEqual([
      'builder', 'cybersecurity', 'ops', 'full-stack', 'reviewer', 'qa'
    ]);
    
    // Verify all predicates are properly defined
    const cybersecurityStep = workflow.steps.find(s => s.agent === 'cybersecurity');
    expect(cybersecurityStep.on.failed.when).toBe('security_issues_found');
    
    const opsStep = workflow.steps.find(s => s.agent === 'ops');
    expect(opsStep.on.failed.when).toBe('ops_issues_found');
    
    const fullStackStep = workflow.steps.find(s => s.agent === 'full-stack');
    expect(fullStackStep.on.failed.when).toBe('implementation_issues_found');
  });
});