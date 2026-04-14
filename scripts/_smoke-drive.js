// scripts/_smoke-drive.js
// Drives two scenarios against a real workflow_instances DB + fake enqueue.
// No BullMQ, no claude subprocess. The engine + automation code is the
// thing under test; the "agents" are canned JSON objects.

import { initMasterDatabase } from '../src/server/db.js';
import { createInstance, loadInstance, listActive } from '../src/server/workflow-instances.js';
import { runAutomation, __setEnqueueForTests } from '../src/worker/automation.js';

initMasterDatabase(process.env.DEVPANEL_STORAGE);

const scenario = process.argv[2];
const pending = [];
__setEnqueueForTests(async (payload) => { pending.push(payload); return { id: `smoke-${pending.length}` }; });

async function run(agent, work_item_id, result, revision = 1) {
  const jobData = {
    job_id: `smoke-${agent}-${work_item_id}`,
    agent,
    workflow: (scenario === 'replan' && agent === 'pm') ? 'replan' : 'work-item',
    workflow_revision: revision,
    plane: { work_item_id, module_id: 'smoke-m', cycle_id: 'smoke-c' },
    work_item: { title: 'smoke' }
  };
  await runAutomation({ jobData, result, startedAt: Date.now() - 10 });
}

function expectEqual(a, b, msg) {
  if (a !== b) { console.error(`FAIL ${msg}: got ${a} want ${b}`); process.exit(1); }
  console.log(`OK   ${msg}`);
}

async function happy() {
  const wi = `wi-happy-${Date.now()}`;
  createInstance({ work_item_id: wi, workflow_name: 'work-item', current_step: 'builder' });
  await run('builder',  wi, { status: 'done', summary: 'built',    memory_writes_count: 0 });
  expectEqual(pending.shift().agent, 'reviewer', 'builder.done enqueues reviewer');
  await run('reviewer', wi, { status: 'done', summary: 'approved', memory_writes_count: 0 });
  expectEqual(pending.shift().agent, 'qa',       'reviewer.done enqueues qa');
  await run('qa',       wi, { status: 'done', summary: 'green',    memory_writes_count: 0 });
  expectEqual(pending.length, 0,                'qa.done is terminal');
  expectEqual(loadInstance({ work_item_id: wi, workflow_name: 'work-item' }).status, 'done', 'instance done');
}

async function replan() {
  const wi = `wi-replan-${Date.now()}`;
  createInstance({ work_item_id: wi, workflow_name: 'work-item', current_step: 'qa' });
  await run('qa', wi, { status: 'failed', blockers: [{ kind: 'code', title: 'bug' }], memory_writes_count: 0 });
  const payload = pending.shift();
  expectEqual(payload.agent, 'pm',                'qa.failed enqueues pm');
  expectEqual(payload.workflow, 'replan',         'pm job is replan workflow');
  expectEqual(loadInstance({ work_item_id: wi, workflow_name: 'work-item' }).status, 'awaiting_approval', 'parent awaits');
  await run('pm', wi, { status: 'done', summary: 'replanned', memory_writes_count: 0 }, 1);
  expectEqual(pending.shift().agent, 'builder',   'replan.done re-enqueues builder');
  expectEqual(loadInstance({ work_item_id: wi, workflow_name: 'work-item' }).revision, 2, 'parent rev=2');
  expectEqual(loadInstance({ work_item_id: wi, workflow_name: 'work-item' }).status, 'running', 'parent running again');
}

(async () => {
  if (scenario === 'happy') await happy();
  else if (scenario === 'replan') await replan();
  else { console.error('unknown scenario'); process.exit(2); }
})();
