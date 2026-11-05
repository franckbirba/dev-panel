// tests/worker/assinie-demo-predicates.test.js
import { describe, it, expect } from 'vitest';
import { predicates } from '../../src/worker/predicates.js';

describe('assinie-demo workflow predicates', () => {
  it('security_issues_found — true when security issues present', () => {
    expect(predicates.security_issues_found({
      issues_found: [{ severity: 'p0', title: 'Critical security flaw' }]
    })).toBe(true);
    
    expect(predicates.security_issues_found({
      issues_found: [{ category: 'security', title: 'Authentication bypass' }]
    })).toBe(true);
    
    expect(predicates.security_issues_found({
      issues_found: [{ title: 'Security vulnerability in API' }]
    })).toBe(true);
    
    expect(predicates.security_issues_found({
      issues_found: [{ severity: 'p3', title: 'Minor UI bug' }]
    })).toBe(false);
    
    expect(predicates.security_issues_found({ issues_found: [] })).toBe(false);
    expect(predicates.security_issues_found({})).toBe(false);
  });

  it('ops_issues_found — true when ops issues present', () => {
    expect(predicates.ops_issues_found({
      issues_found: [{ category: 'ops', title: 'Deployment pipeline broken' }]
    })).toBe(true);
    
    expect(predicates.ops_issues_found({
      issues_found: [{ category: 'operations', title: 'Server provisioning failed' }]
    })).toBe(true);
    
    expect(predicates.ops_issues_found({
      issues_found: [{ title: 'Ops automation failure' }]
    })).toBe(true);
    
    expect(predicates.ops_issues_found({
      issues_found: [{ title: 'Operations dashboard down' }]
    })).toBe(true);
    
    expect(predicates.ops_issues_found({
      issues_found: [{ category: 'development', title: 'Code bug' }]
    })).toBe(false);
    
    expect(predicates.ops_issues_found({ issues_found: [] })).toBe(false);
    expect(predicates.ops_issues_found({})).toBe(false);
  });

  it('implementation_issues_found — true when implementation issues present', () => {
    expect(predicates.implementation_issues_found({
      issues_found: [{ category: 'implementation', title: 'Build process broken' }]
    })).toBe(true);
    
    expect(predicates.implementation_issues_found({
      issues_found: [{ title: 'Build failure in CI pipeline' }]
    })).toBe(true);
    
    expect(predicates.implementation_issues_found({
      issues_found: [{ category: 'build', title: 'Compilation error' }]
    })).toBe(true);
    
    expect(predicates.implementation_issues_found({
      issues_found: [{ category: 'development', title: 'Feature request' }]
    })).toBe(false);
    
    expect(predicates.implementation_issues_found({ issues_found: [] })).toBe(false);
    expect(predicates.implementation_issues_found({})).toBe(false);
  });
});