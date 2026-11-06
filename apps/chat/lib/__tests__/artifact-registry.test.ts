import { describe, it, expect, beforeEach } from 'vitest';
import { artifactRegistry, MergeArtifact, DispatchArtifact } from '../artifact-registry';

describe('artifact-registry', () => {
  beforeEach(() => {
    // Clear the registry before each test
    const artifacts = artifactRegistry.getAll();
    artifacts.forEach(artifact => artifactRegistry.unregister(artifact.id));
  });

  it('should register and retrieve artifacts', () => {
    const mergeArtifact: MergeArtifact = {
      id: 'merge-1',
      type: 'merge',
      title: 'Merge PR #123',
      createdAt: new Date(),
      pr: {
        number: 123,
        title: 'Test PR',
        repo: 'test/repo',
        base_branch: 'main',
        head_branch: 'feature',
        head_sha: 'abc123',
        base_sha: 'def456'
      },
      conflicts: []
    };

    artifactRegistry.register(mergeArtifact);
    
    const retrieved = artifactRegistry.getArtifact('merge-1');
    expect(retrieved).toEqual(mergeArtifact);
  });

  it('should set and get active artifact', () => {
    const mergeArtifact: MergeArtifact = {
      id: 'merge-1',
      type: 'merge',
      title: 'Merge PR #123',
      createdAt: new Date(),
      pr: {
        number: 123,
        title: 'Test PR',
        repo: 'test/repo',
        base_branch: 'main',
        head_branch: 'feature',
        head_sha: 'abc123',
        base_sha: 'def456'
      },
      conflicts: []
    };

    artifactRegistry.register(mergeArtifact);
    artifactRegistry.setActive('merge-1');
    
    expect(artifactRegistry.getActiveId()).toBe('merge-1');
  });

  it('should handle parent context inheritance', () => {
    const mergeArtifact: MergeArtifact = {
      id: 'merge-1',
      type: 'merge',
      title: 'Merge PR #123',
      createdAt: new Date(),
      pr: {
        number: 123,
        title: 'Test PR',
        repo: 'test/repo',
        base_branch: 'main',
        head_branch: 'feature',
        head_sha: 'abc123',
        base_sha: 'def456'
      },
      conflicts: []
    };

    const dispatchArtifact: DispatchArtifact = {
      id: 'dispatch-1',
      type: 'dispatch',
      title: 'Dispatch job',
      createdAt: new Date(),
      parentId: 'merge-1',
      parent: {
        type: 'merge-coord:fail',
        pr_number: 123,
        files: ['src/test.ts']
      },
      role: 'builder',
      scope: {
        files: ['src/test.ts']
      },
      directive: 'Fix the merge conflict'
    };

    artifactRegistry.register(mergeArtifact);
    artifactRegistry.register(dispatchArtifact);
    
    const parentContext = artifactRegistry.getParentContext('dispatch-1');
    expect(parentContext).toEqual(mergeArtifact);
  });
});