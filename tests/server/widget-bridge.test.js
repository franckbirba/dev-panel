import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  enqueueWidgetMessage,
  _setInboundQueueForTests,
  SHELLY_PUBLIC_INBOUND_QUEUE
} from '../../src/server/widget-bridge.js';

describe('widget-bridge enqueue', () => {
  let fakeQueue, captured;

  beforeEach(() => {
    captured = [];
    fakeQueue = {
      add: async (name, data) => {
        captured.push({ name, data });
        return { id: 'job-' + (captured.length) };
      }
    };
    _setInboundQueueForTests(fakeQueue);
  });

  afterEach(() => {
    _setInboundQueueForTests(null);
  });

  it('queue name constant is shelly-public-inbound', () => {
    expect(SHELLY_PUBLIC_INBOUND_QUEUE).toBe('shelly-public-inbound');
  });

  it('enqueueWidgetMessage adds with required payload + returns job id', async () => {
    const id = await enqueueWidgetMessage({
      session_id: 'ws_abc',
      project_id: 'proj-1',
      message_id: 42,
      content: 'hello'
    });
    expect(id).toBe('job-1');
    expect(captured).toHaveLength(1);
    expect(captured[0].name).toBe('widget-inbound');
    expect(captured[0].data).toMatchObject({
      session_id: 'ws_abc',
      project_id: 'proj-1',
      message_id: 42,
      content: 'hello'
    });
    expect(captured[0].data.enqueued_at).toBeTruthy();
  });

  it('throws when required fields are missing', async () => {
    await expect(enqueueWidgetMessage({ session_id: 'x', project_id: '', content: 'c' }))
      .rejects.toThrow(/required/);
    await expect(enqueueWidgetMessage({ session_id: '', project_id: 'p', content: 'c' }))
      .rejects.toThrow(/required/);
    await expect(enqueueWidgetMessage({ session_id: 'x', project_id: 'p', content: '' }))
      .rejects.toThrow(/required/);
  });

  it('completes well under the 1s budget', async () => {
    const t0 = Date.now();
    await enqueueWidgetMessage({ session_id: 'ws_x', project_id: 'p', content: 'c' });
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});
