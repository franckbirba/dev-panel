// tests/worker/soul-agents.test.js
import { describe, it, expect } from 'vitest';
import { readSoul } from '../../src/worker/prompt-builder.js';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const PROJECT_ROOT = process.env.PROJECT_ROOT || process.cwd();

describe('SOUL agents', () => {
  const agents = ['full-stack', 'ops', 'cybersecurity'];
  
  it.each(agents)('should have a SOUL.md file for %s agent', (agent) => {
    const soulPath = join(PROJECT_ROOT, '.agents', agent, 'SOUL.md');
    expect(existsSync(soulPath)).toBe(true);
  });

  it.each(agents)('should have a PLAYBOOK.md file for %s agent', (agent) => {
    const playbookPath = join(PROJECT_ROOT, '.agents', agent, 'PLAYBOOK.md');
    expect(existsSync(playbookPath)).toBe(true);
  });

  it.each(agents)('should be able to load SOUL for %s agent', (agent) => {
    const soul = readSoul(agent);
    expect(soul).toContain('# ' + agent.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join('-'));
    expect(soul).toContain('## Identity');
    expect(soul).toContain('## Mission');
    expect(soul).toContain('## You MUST');
    expect(soul).toContain('## You MUST NOT');
  });

  it('should have proper structure in full-stack SOUL', () => {
    const soul = readSoul('full-stack');
    expect(soul).toContain('Full-Stack Developer');
    expect(soul).toContain('frontend and backend');
    expect(soul).toContain('superpowers:frontend-development');
    expect(soul).toContain('superpowers:backend-development');
  });

  it('should have proper structure in ops SOUL', () => {
    const soul = readSoul('ops');
    expect(soul).toContain('DevOps engineer');
    expect(soul).toContain('infrastructure as code');
    expect(soul).toContain('superpowers:infrastructure-review');
    expect(soul).toContain('superpowers:security-audit');
  });

  it('should have proper structure in cybersecurity SOUL', () => {
    const soul = readSoul('cybersecurity');
    expect(soul).toContain('Security analyst');
    expect(soul).toContain('security vulnerabilities');
    expect(soul).toContain('superpowers:security-audit');
    expect(soul).toContain('superpowers:vulnerability-scanning');
  });
});