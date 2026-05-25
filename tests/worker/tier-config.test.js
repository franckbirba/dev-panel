// tests/worker/tier-config.test.js
//
// Gap #4: tier-config.js loads role → tier mapping from tiers.yaml. These
// tests pin the public contract (tierFor / isCheapTier / isHardTier) AND the
// cache-reset hook so other tests (or a hot-reload during dev) can force a
// re-read from disk.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  tierFor,
  isCheapTier,
  isHardTier,
  __resetTierConfigForTests
} from '../../src/worker/tier-config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TIERS_PATH = join(__dirname, '..', '..', 'src', 'worker', 'tiers.yaml');

describe('tier-config', () => {
  beforeEach(() => {
    __resetTierConfigForTests();
  });

  it('tierFor returns "cheap" for a cheap-tier role', () => {
    expect(tierFor('builder')).toBe('cheap');
  });

  it('tierFor returns "hard" for a hard-tier role', () => {
    expect(tierFor('reviewer')).toBe('hard');
  });

  it('tierFor returns null for an unknown role', () => {
    expect(tierFor('nonexistent')).toBeNull();
  });

  it('isCheapTier / isHardTier mirror tierFor', () => {
    expect(isCheapTier('designer')).toBe(true);
    expect(isCheapTier('reviewer')).toBe(false);
    expect(isHardTier('merge-coordinator')).toBe(true);
    expect(isHardTier('builder')).toBe(false);
    expect(isHardTier('nonexistent')).toBe(false);
  });

  it('__resetTierConfigForTests clears the cache so the next call re-reads disk', () => {
    const original = readFileSync(TIERS_PATH, 'utf8');
    try {
      // Warm the cache with the real file: "synthetic-tier-probe" is unknown.
      expect(tierFor('synthetic-tier-probe')).toBeNull();

      // Mutate the file on disk — without a reset the cache hides the change.
      writeFileSync(
        TIERS_PATH,
        original + '\n  - synthetic-tier-probe\n',
        'utf8'
      );
      expect(tierFor('synthetic-tier-probe')).toBeNull();

      // After the reset, the next call MUST re-read disk and see the probe.
      __resetTierConfigForTests();
      expect(tierFor('synthetic-tier-probe')).toBe('hard');
    } finally {
      writeFileSync(TIERS_PATH, original, 'utf8');
      __resetTierConfigForTests();
    }
  });
});
