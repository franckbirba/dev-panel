// src/worker/tier-config.js
//
// Gap #4: single source of truth for role → tier mapping. Both
// select-claude-model.js and goose-driver.js (and, historically, any other
// driver that needed to know whether a role was hard-tier) used to duplicate
// the same Sets inline; adding a role meant patching every file. This module
// loads the mapping once from tiers.yaml (sibling file) and exposes
// tierFor(role) / isCheapTier(role) / isHardTier(role).
import { readFileSync } from 'fs';
import { parse } from 'yaml';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TIERS_PATH = join(__dirname, 'tiers.yaml');

let _cache = null;

function load() {
  if (_cache) return _cache;
  const raw = readFileSync(TIERS_PATH, 'utf8');
  const doc = parse(raw);
  _cache = {
    cheap: new Set(doc?.cheap || []),
    hard:  new Set(doc?.hard  || [])
  };
  return _cache;
}

export function tierFor(role) {
  const { cheap, hard } = load();
  if (cheap.has(role)) return 'cheap';
  if (hard.has(role))  return 'hard';
  return null;
}

export function isCheapTier(role) { return tierFor(role) === 'cheap'; }
export function isHardTier(role)  { return tierFor(role) === 'hard'; }

export function __resetTierConfigForTests() { _cache = null; }
