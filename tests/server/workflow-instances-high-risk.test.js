// tests/server/workflow-instances-high-risk.test.js
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { spawnSync } from 'child_process';
import { startPg, stopPg, truncateOrchestration } from '../_helpers/pg.js';

const hasDocker = spawnSync('docker', ['version'], { stdio: 'ignore' }).status === 0;
const d = hasDocker ? describe : describe.skip;

d('workflow-instances — high-risk label handling', () => {
  let createInstance, loadInstance, updateInstance, checkHighRiskAndAwaitApproval;

  beforeAll(async () => {
    await startPg();
    ({ createInstance, loadInstance, updateInstance, checkHighRiskAndAwaitApproval } = await import('../../src/server/workflow-instances.js'));
  }, 60000);

  afterAll(async () => {
    await stopPg();
  });

  beforeEach(() => truncateOrchestration());

  it('checkHighRiskAndAwaitApproval returns true for high-risk labels', async () => {
    // Create workflow instance
    const instanceId = await createInstance({
      work_item_id: 'wi-test-high-risk',
      workflow_name: 'test-workflow',
      current_step: 'test-step'
    });

    // Test with direct high-risk label
    const isHighRisk1 = await checkHighRiskAndAwaitApproval({
      work_item_id: 'wi-test-high-risk',
      workflow_name: 'test-workflow',
      instance_id: instanceId,
      context: {
        labels: ['high-risk']
      }
    });

    expect(isHighRisk1).toBe(true);

    // Verify instance status was updated
    const instance1 = await loadInstance({ work_item_id: 'wi-test-high-risk', workflow_name: 'test-workflow' });
    expect(instance1.status).toBe('awaiting_approval');
  });

  it('checkHighRiskAndAwaitApproval returns true for domain-specific high-risk labels', async () => {
    // Create workflow instance
    const instanceId = await createInstance({
      work_item_id: 'wi-test-domain-risk',
      workflow_name: 'test-workflow',
      current_step: 'test-step'
    });

    // Test with domain-specific high-risk label
    const isHighRisk = await checkHighRiskAndAwaitApproval({
      work_item_id: 'wi-test-domain-risk',
      workflow_name: 'test-workflow',
      instance_id: instanceId,
      context: {
        labels: ['migration', 'auth']
      }
    });

    expect(isHighRisk).toBe(true);

    // Verify instance status was updated
    const instance = await loadInstance({ work_item_id: 'wi-test-domain-risk', workflow_name: 'test-workflow' });
    expect(instance.status).toBe('awaiting_approval');
  });

  it('checkHighRiskAndAwaitApproval returns false for normal labels', async () => {
    // Create workflow instance
    await createInstance({
      work_item_id: 'wi-test-normal',
      workflow_name: 'test-workflow',
      current_step: 'test-step'
    });

    // Test with normal labels
    const isHighRisk = await checkHighRiskAndAwaitApproval({
      work_item_id: 'wi-test-normal',
      workflow_name: 'test-workflow',
      instance_id: 'test-instance-id',
      context: {
        labels: ['feature', 'enhancement']
      }
    });

    expect(isHighRisk).toBe(false);

    // Verify instance status was not changed to awaiting_approval
    const instance = await loadInstance({ work_item_id: 'wi-test-normal', workflow_name: 'test-workflow' });
    expect(instance.status).toBe('running'); // Default status
  });

  it('checkHighRiskAndAwaitApproval handles empty context gracefully', async () => {
    // Create workflow instance
    await createInstance({
      work_item_id: 'wi-test-empty',
      workflow_name: 'test-workflow',
      current_step: 'test-step'
    });

    // Test with empty context
    const isHighRisk = await checkHighRiskAndAwaitApproval({
      work_item_id: 'wi-test-empty',
      workflow_name: 'test-workflow',
      instance_id: 'test-instance-id',
      context: {}
    });

    expect(isHighRisk).toBe(false);
  });
});