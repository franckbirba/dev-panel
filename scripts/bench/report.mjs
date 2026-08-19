// scripts/bench/report.mjs — matrice de verdicts du bench.
// usage: node report.mjs <results.jsonl>  → markdown sur stdout.
import { readFileSync } from 'node:fs';

const lines = readFileSync(process.argv[2], 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const scenarios = [...new Set(lines.map((l) => l.scenario))].sort();
const drivers = [...new Set(lines.map((l) => l.driver))].sort();

const cell = (s, d) => {
  const r = lines.filter((l) => l.scenario === s && l.driver === d).pop();
  if (!r) return '—';
  const icon = { PASS: '✅ PASS', FAIL: '❌ FAIL', NOT_IMPLEMENTED: '⏳ NOT_IMPL', CHECK_SKIPPED: '⚠️ SKIPPED', RUNNER_ERROR: '💥 RUNNER' }[r.result] ?? r.result;
  return icon;
};

console.log(`# Bench moteur — ${new Date().toISOString().slice(0, 16)}Z\n`);
console.log(`| Scénario | ${drivers.join(' | ')} |`);
console.log(`|---|${drivers.map(() => '---').join('|')}|`);
for (const s of scenarios) {
  console.log(`| ${s} | ${drivers.map((d) => cell(s, d)).join(' | ')} |`);
}

const pi = lines.filter((l) => l.driver === 'pi');
const piAllPass = pi.length > 0 && scenarios.every((s) => {
  const r = pi.filter((l) => l.scenario === s).pop();
  // D5/D6 tournent une seule fois (per_driver=false, colonne claude) — absents de pi = OK.
  return !r || r.result === 'PASS';
}) && pi.every((r) => r.result === 'PASS');

console.log('');
console.log(piAllPass
  ? '## 🟢 GO ZENO — colonne plancher entièrement PASS (règle du 2026-08-19)'
  : '## 🔴 NO-GO — la colonne plancher (pi) doit être entièrement PASS, zéro NOT_IMPLEMENTED, zéro FAIL (arbitrage Franck 2026-08-19)');

const failing = lines.filter((l) => l.result === 'FAIL' || l.result === 'RUNNER_ERROR');
if (failing.length) {
  console.log('\n### Détail des échecs\n');
  for (const f of failing) {
    console.log(`- **${f.scenario} × ${f.driver}** : ${(f.checks ?? []).filter((c) => c.status === 'FAIL').map((c) => `${c.name} (${c.detail})`).join(' ; ') || f.error}`);
  }
}
