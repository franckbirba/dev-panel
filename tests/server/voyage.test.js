// tests/server/voyage.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { embed } from '../../src/server/voyage.js';

describe('voyage embed', () => {
  beforeEach(() => {
    process.env.VOYAGE_API_KEY = 'test-key';
    process.env.VOYAGE_MODEL = 'voyage-code-3';
    global.fetch = vi.fn();
  });

  it('returns a 1024-dim vector for a string input', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: Array(1024).fill(0.01) }] })
    });
    const v = await embed('hello world');
    expect(v).toHaveLength(1024);
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.voyageai.com/v1/embeddings',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer test-key' })
      })
    );
  });

  it('throws if VOYAGE_API_KEY is missing', async () => {
    delete process.env.VOYAGE_API_KEY;
    await expect(embed('x')).rejects.toThrow(/VOYAGE_API_KEY/);
  });

  it('throws on non-ok response', async () => {
    global.fetch.mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' });
    await expect(embed('x')).rejects.toThrow(/Voyage.*500/);
  });
});
