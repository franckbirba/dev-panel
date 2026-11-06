// tests/modules/preview-runner.test.js
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PreviewRunner } from '../../src/modules/preview-runner.js';
import { execSync } from 'child_process';

// Mock child_process
vi.mock('child_process', () => ({
  execSync: vi.fn(),
  spawn: vi.fn()
}));

describe('PreviewRunner', () => {
  let previewRunner;
  
  beforeEach(() => {
    previewRunner = new PreviewRunner('/test/worktree/path');
    vi.clearAllMocks();
  });
  
  describe('generateProjectName', () => {
    it('should generate a unique project name based on worktree path', () => {
      const projectName = previewRunner.generateProjectName('/test/worktree/path');
      expect(projectName).toMatch(/^preview_path_\d+$/);
    });
  });
  
  describe('checkDockerCompose', () => {
    it('should not throw when docker compose is available', () => {
      execSync.mockImplementation(() => {});
      expect(() => previewRunner.checkDockerCompose()).not.toThrow();
    });
    
    it('should throw when docker compose is not available', () => {
      execSync.mockImplementation(() => {
        throw new Error('command not found');
      });
      expect(() => previewRunner.checkDockerCompose()).toThrow(/docker compose v2 is required/);
    });
  });
  
  describe('getServicePort', () => {
    it('should extract port from docker compose port output', () => {
      execSync.mockReturnValue('0.0.0.0:32768');
      const port = previewRunner.getServicePort('frontend');
      expect(port).toBe('32768');
    });
    
    it('should return null when port extraction fails', () => {
      execSync.mockImplementation(() => {
        throw new Error('port not found');
      });
      const port = previewRunner.getServicePort('frontend');
      expect(port).toBeNull();
    });
  });
});