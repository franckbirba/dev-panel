import { describe, it, expect, vi, beforeEach } from 'vitest';

const ghMock = vi.hoisted(() => ({
  getContent: vi.fn(),
  createOrUpdateFileContents: vi.fn()
}));

vi.mock('octokit', () => ({
  Octokit: function Octokit() {
    this.rest = {
      repos: {
        getContent: ghMock.getContent,
        createOrUpdateFileContents: ghMock.createOrUpdateFileContents
      }
    };
  }
}));

const fileText = (lines) => Buffer.from(
  '# header\n' + lines.join('\n') + '\n', 'utf8'
).toString('base64');

beforeEach(() => {
  process.env.GITHUB_TOKEN = 'test-token';
  ghMock.getContent.mockReset();
  ghMock.createOrUpdateFileContents.mockReset();
});

describe('listAllowlist', () => {
  it('parses one-per-line, ignores comments and blanks', async () => {
    ghMock.getContent.mockResolvedValue({
      data: {
        type: 'file',
        sha: 'abc',
        content: Buffer.from(
          '# comment\n\nfranck@gmail.com\nalice@example.com\n# trailing\n',
          'utf8'
        ).toString('base64')
      }
    });
    const { listAllowlist } = await import('../../src/server/allowlist.js');
    expect(await listAllowlist()).toEqual(['franck@gmail.com', 'alice@example.com']);
  });
});

describe('addEmail', () => {
  it('rejects invalid email with INVALID_EMAIL', async () => {
    const { addEmail } = await import('../../src/server/allowlist.js');
    await expect(addEmail('nope')).rejects.toMatchObject({ code: 'INVALID_EMAIL' });
    expect(ghMock.getContent).not.toHaveBeenCalled();
  });

  it('skips commit when email already present (case-insensitive)', async () => {
    ghMock.getContent.mockResolvedValue({
      data: { type: 'file', sha: 'abc', content: fileText(['Franck@Gmail.com']) }
    });
    const { addEmail } = await import('../../src/server/allowlist.js');
    const res = await addEmail('franck@gmail.com');
    expect(res.alreadyPresent).toBe(true);
    expect(ghMock.createOrUpdateFileContents).not.toHaveBeenCalled();
  });

  it('appends new email and commits', async () => {
    ghMock.getContent.mockResolvedValue({
      data: { type: 'file', sha: 'abc', content: fileText(['franck@gmail.com']) }
    });
    ghMock.createOrUpdateFileContents.mockResolvedValue({ data: {} });
    const { addEmail } = await import('../../src/server/allowlist.js');
    const res = await addEmail('alice@example.com');
    expect(res.alreadyPresent).toBe(false);
    expect(res.emails).toEqual(['franck@gmail.com', 'alice@example.com']);
    expect(ghMock.createOrUpdateFileContents).toHaveBeenCalledTimes(1);
    const call = ghMock.createOrUpdateFileContents.mock.calls[0][0];
    expect(call.message).toMatch(/invite alice@example\.com/);
    expect(call.sha).toBe('abc');
    const written = Buffer.from(call.content, 'base64').toString('utf8');
    expect(written).toContain('franck@gmail.com');
    expect(written).toContain('alice@example.com');
  });
});

describe('removeEmail', () => {
  it('returns removed:false when email not present', async () => {
    ghMock.getContent.mockResolvedValue({
      data: { type: 'file', sha: 'abc', content: fileText(['franck@gmail.com']) }
    });
    const { removeEmail } = await import('../../src/server/allowlist.js');
    const res = await removeEmail('alice@example.com');
    expect(res.removed).toBe(false);
    expect(ghMock.createOrUpdateFileContents).not.toHaveBeenCalled();
  });

  it('removes email and commits', async () => {
    ghMock.getContent.mockResolvedValue({
      data: { type: 'file', sha: 'abc', content: fileText(['franck@gmail.com', 'alice@example.com']) }
    });
    ghMock.createOrUpdateFileContents.mockResolvedValue({ data: {} });
    const { removeEmail } = await import('../../src/server/allowlist.js');
    const res = await removeEmail('alice@example.com');
    expect(res.removed).toBe(true);
    expect(res.emails).toEqual(['franck@gmail.com']);
    const call = ghMock.createOrUpdateFileContents.mock.calls[0][0];
    expect(call.message).toMatch(/remove alice@example\.com/);
  });

  it('refuses to empty the allowlist', async () => {
    ghMock.getContent.mockResolvedValue({
      data: { type: 'file', sha: 'abc', content: fileText(['franck@gmail.com']) }
    });
    const { removeEmail } = await import('../../src/server/allowlist.js');
    await expect(removeEmail('franck@gmail.com')).rejects.toMatchObject({ code: 'WOULD_EMPTY_ALLOWLIST' });
    expect(ghMock.createOrUpdateFileContents).not.toHaveBeenCalled();
  });
});
