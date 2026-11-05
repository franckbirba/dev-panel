// tests/integration/preview-runner-integration.test.js
import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { existsSync } from 'fs';
import { createPreviewRunner } from '../../src/modules/preview-runner.js';

// This test requires Docker to be available
describe('PreviewRunner Integration', () => {
  // Skip if Docker is not available
  let hasDocker = false;
  try {
    const { execSync } = require('child_process');
    execSync('docker info', { stdio: 'ignore' });
    hasDocker = true;
  } catch (error) {
    // Docker not available
  }
  
  // Also check if we're in the right environment (dev-panel project)
  const projectRoot = process.env.PROJECT_ROOT || process.cwd();
  const hasDemoCompose = existsSync(join(projectRoot, 'templates/demo-app/docker-compose.yml'));
  
  const runIntegrationTests = hasDocker && hasDemoCompose;
  
  it.runIf(runIntegrationTests)('should validate docker compose configuration', () => {
    // Test that the docker-compose.yml file is valid
    const { execSync } = require('child_process');
    const composePath = join(projectRoot, 'templates/demo-app/docker-compose.yml');
    
    // Validate the compose file
    expect(() => {
      execSync(`docker compose -f ${composePath} config`, { stdio: 'pipe' });
    }).not.toThrow();
  });
  
  it.runIf(runIntegrationTests)('should show services in docker compose ps', () => {
    // Test that we can list services
    const { execSync } = require('child_process');
    const composePath = join(projectRoot, 'templates/demo-app/docker-compose.yml');
    
    // List services
    const output = execSync(`docker compose -f ${composePath} config --services`, { 
      stdio: 'pipe', 
      encoding: 'utf8' 
    });
    
    const services = output.trim().split('\n');
    expect(services).toContain('frontend');
    expect(services).toContain('backend');
    expect(services).toContain('db');
    expect(services).toContain('redis');
  });
  
  it.runIf(!runIntegrationTests)('skipped due to missing Docker or demo compose file', () => {
    console.log('Skipping integration tests - Docker or demo compose file not available');
    expect(true).toBe(true);
  });
});