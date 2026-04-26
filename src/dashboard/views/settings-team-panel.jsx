// src/dashboard/views/settings-team-panel.jsx
// Two stacked tables: members + routing. Members managed inline (add via
// inline form, delete via row button). Routing kept in a draft state until
// "Save routing" fires PUT /api/team/routing as a full replace.
import { useEffect, useState } from 'react';

export default function TeamPanel({ project, apiKey, apiUrl }) {
  const [members, setMembers] = useState([]);
  const [routing, setRouting] = useState([]);          // canonical from server
  const [draftRouting, setDraftRouting] = useState([]); // editable copy
  const [availableBots, setAvailableBots] = useState([]);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [newBotId, setNewBotId] = useState('');
  const [savingRouting, setSavingRouting] = useState(false);
  const [patterns, setPatterns] = useState([]);
  const [draftPatterns, setDraftPatterns] = useState([]);
  const [savingPatterns, setSavingPatterns] = useState(false);
  const [error, setError] = useState(null);

  const headers = { 'X-API-Key': apiKey, 'Content-Type': 'application/json' };

  async function loadAll() {
    const projectId = project?.id;
    if (!projectId) return;
    const [teamRes, botsRes, patternsRes] = await Promise.all([
      fetch(`${apiUrl}/api/team`, { headers }),
      fetch(`${apiUrl}/api/dev-bots/available?project=${encodeURIComponent(projectId)}`, { headers }),
      fetch(`${apiUrl}/api/team/url-patterns`, { headers })
    ]);
    if (teamRes.ok) {
      const t = await teamRes.json();
      setMembers(t.members);
      setRouting(t.routing);
      setDraftRouting(t.routing);
    }
    if (botsRes.ok) setAvailableBots(await botsRes.json());
    if (patternsRes.ok) {
      const p = await patternsRes.json();
      setPatterns(p);
      setDraftPatterns(p);
    }
  }

  useEffect(() => { loadAll(); }, [project?.id]); // eslint-disable-line

  async function addMemberAction() {
    setError(null);
    const r = await fetch(`${apiUrl}/api/team/members`, {
      method: 'POST', headers,
      body: JSON.stringify({ display_name: newName, dev_bot_id: parseInt(newBotId, 10) })
    });
    if (!r.ok) { setError((await r.json()).error || `HTTP ${r.status}`); return; }
    setNewName(''); setNewBotId(''); setAdding(false);
    await loadAll();
  }

  async function deleteMemberAction(id) {
    if (!confirm('Remove this member? Routing rules pointing to them will be removed too.')) return;
    await fetch(`${apiUrl}/api/team/members/${id}`, { method: 'DELETE', headers });
    await loadAll();
  }

  async function saveRouting() {
    setSavingRouting(true);
    setError(null);
    const payload = draftRouting
      .filter(r => r.label && r.member_id)
      .map(r => ({ label: r.label, member_id: r.member_id }));
    const r = await fetch(`${apiUrl}/api/team/routing`, {
      method: 'PUT', headers, body: JSON.stringify(payload)
    });
    if (!r.ok) {
      setError((await r.json()).error || `HTTP ${r.status}`);
    } else {
      const fresh = await r.json();
      setRouting(fresh);
      setDraftRouting(fresh);
    }
    setSavingRouting(false);
  }

  function addEmptyRule() {
    setDraftRouting(prev => [...prev, { label: '', member_id: null }]);
  }

  function setRuleLabel(idx, label) {
    setDraftRouting(prev => prev.map((r, i) => i === idx ? { ...r, label } : r));
  }

  function setRuleMember(idx, member_id) {
    setDraftRouting(prev => prev.map((r, i) => i === idx ? { ...r, member_id: parseInt(member_id, 10) } : r));
  }

  function removeRule(idx) {
    setDraftRouting(prev => prev.filter((_, i) => i !== idx));
  }

  async function savePatterns() {
    setSavingPatterns(true);
    setError(null);
    const payload = draftPatterns
      .filter(p => p.pattern && p.label)
      .map((p, i) => ({ pattern: p.pattern, label: p.label, priority: 100 + i }));
    const r = await fetch(`${apiUrl}/api/team/url-patterns`, {
      method: 'PUT', headers, body: JSON.stringify(payload)
    });
    if (!r.ok) {
      setError((await r.json()).error || `HTTP ${r.status}`);
    } else {
      const fresh = await r.json();
      setPatterns(fresh);
      setDraftPatterns(fresh);
    }
    setSavingPatterns(false);
  }
  function addEmptyPattern() {
    setDraftPatterns(prev => [...prev, { pattern: '', label: '' }]);
  }
  function setPatternField(idx, field, value) {
    setDraftPatterns(prev => prev.map((p, i) => i === idx ? { ...p, [field]: value } : p));
  }
  function removePattern(idx) {
    setDraftPatterns(prev => prev.filter((_, i) => i !== idx));
  }

  const dirty = JSON.stringify(draftRouting) !== JSON.stringify(routing);
  const dirtyPatterns = JSON.stringify(draftPatterns) !== JSON.stringify(patterns);
  const labelOptions = Array.from(new Set(routing.map(r => r.label))).sort();

  return (
    <div className="flex flex-col gap-8 px-6 py-6">
      {error && (
        <div className="text-[13px] text-[var(--color-error)] bg-[var(--color-error)]/10 border border-[var(--color-error)]/20 rounded px-3 py-2">
          {error}
        </div>
      )}

      <section>
        <h2 className="text-[14px] font-semibold mb-3">Members</h2>
        {members.length === 0 && !adding && (
          <p className="text-[13px] text-[var(--color-foreground-muted)] mb-3">
            Définis qui s&apos;occupe des bug reports pour ce projet. Chaque personne a besoin d&apos;un bot Telegram pairé — voir <code>/pair</code> dans le channel Telegram.
          </p>
        )}
        <table className="w-full text-[13px]">
          <thead className="text-[var(--color-foreground-muted)]">
            <tr>
              <th className="text-left font-normal py-1">Display name</th>
              <th className="text-left font-normal py-1">Telegram bot</th>
              <th className="text-left font-normal py-1">Owner</th>
              <th className="w-24"></th>
            </tr>
          </thead>
          <tbody>
            {members.map(m => (
              <tr key={m.id} className="border-t border-[var(--color-border-subtle)]">
                <td className="py-2">{m.display_name}</td>
                <td className="py-2">@{m.dev_bot?.username} <span className="text-[var(--color-foreground-muted)]">({m.dev_bot?.label})</span></td>
                <td className="py-2">{m.dev_bot?.owner_first_name || '—'}</td>
                <td className="py-2 text-right">
                  <button onClick={() => deleteMemberAction(m.id)} className="text-[var(--color-error)] hover:underline">Remove</button>
                </td>
              </tr>
            ))}
            {adding && (
              <tr className="border-t border-[var(--color-border-subtle)]">
                <td className="py-2"><input value={newName} onChange={e => setNewName(e.target.value)} placeholder="Alex" className="w-full bg-transparent border border-[var(--color-border-subtle)] rounded px-2 py-1" /></td>
                <td className="py-2">
                  {availableBots.length === 0 ? (
                    <span className="text-[var(--color-foreground-muted)]">Aucun bot disponible — paire-en un en Telegram d&apos;abord : envoie <code>/pair &lt;token&gt; &lt;label&gt;</code> à <code>@Therealshelly42bot</code>.</span>
                  ) : (
                    <select value={newBotId} onChange={e => setNewBotId(e.target.value)} className="w-full bg-transparent border border-[var(--color-border-subtle)] rounded px-2 py-1">
                      <option value="">Pick a bot…</option>
                      {availableBots.map(b => (
                        <option key={b.id} value={b.id}>@{b.bot_username} ({b.bot_label})</option>
                      ))}
                    </select>
                  )}
                </td>
                <td></td>
                <td className="py-2 text-right">
                  <button onClick={addMemberAction} disabled={!newName || !newBotId} className="text-[var(--color-foreground)] hover:underline mr-3 disabled:opacity-40">Add</button>
                  <button onClick={() => { setAdding(false); setNewName(''); setNewBotId(''); }} className="text-[var(--color-foreground-muted)] hover:underline">Cancel</button>
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {!adding && (
          <button onClick={() => setAdding(true)} className="mt-3 text-[13px] text-[var(--color-accent)] hover:underline">+ Add member</button>
        )}
      </section>

      <section>
        <h2 className="text-[14px] font-semibold mb-3">Routing</h2>
        {members.length === 0 ? (
          <p className="text-[13px] text-[var(--color-foreground-muted)]">Add at least one member before defining routing rules.</p>
        ) : (
          <>
            <table className="w-full text-[13px]">
              <thead className="text-[var(--color-foreground-muted)]">
                <tr>
                  <th className="text-left font-normal py-1 w-1/2">Label</th>
                  <th className="text-left font-normal py-1">Member</th>
                  <th className="w-24"></th>
                </tr>
              </thead>
              <tbody>
                {draftRouting.map((rule, idx) => (
                  <tr key={idx} className="border-t border-[var(--color-border-subtle)]">
                    <td className="py-2">
                      <input
                        value={rule.label}
                        onChange={e => setRuleLabel(idx, e.target.value)}
                        placeholder="pedago"
                        className="w-full bg-transparent border border-[var(--color-border-subtle)] rounded px-2 py-1"
                      />
                    </td>
                    <td className="py-2">
                      <select
                        value={rule.member_id || ''}
                        onChange={e => setRuleMember(idx, e.target.value)}
                        className="w-full bg-transparent border border-[var(--color-border-subtle)] rounded px-2 py-1"
                      >
                        <option value="">Pick a member…</option>
                        {members.map(m => (
                          <option key={m.id} value={m.id}>{m.display_name}</option>
                        ))}
                      </select>
                    </td>
                    <td className="py-2 text-right">
                      <button onClick={() => removeRule(idx)} className="text-[var(--color-error)] hover:underline">Remove</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-3 flex items-center gap-3">
              <button onClick={addEmptyRule} className="text-[13px] text-[var(--color-accent)] hover:underline">+ Add routing rule</button>
              <div className="flex-1" />
              {dirty && (
                <button onClick={() => setDraftRouting(routing)} className="text-[13px] text-[var(--color-foreground-muted)] hover:underline">
                  Discard
                </button>
              )}
              <button
                onClick={saveRouting}
                disabled={!dirty || savingRouting}
                className="text-[13px] px-3 py-1 rounded bg-[var(--color-accent)] text-[var(--color-accent-foreground)] disabled:opacity-40"
              >
                {savingRouting ? 'Saving…' : 'Save routing'}
              </button>
            </div>
          </>
        )}
      </section>

      <section>
        <h2 className="text-[14px] font-semibold mb-1">URL patterns</h2>
        <p className="text-[13px] text-[var(--color-foreground-muted)] mb-3">
          Classifie automatiquement les bug reports selon l&apos;URL de la page où ils sont signalés. Premier match (ordre de la liste) gagne. Le pattern est un sous-texte du chemin (ex&nbsp;: <code>/admissions</code> matche <code>/app/admissions/123</code>).
        </p>
        {labelOptions.length === 0 ? (
          <p className="text-[13px] text-[var(--color-foreground-muted)]">Définis au moins un label de routing avant d&apos;ajouter des patterns.</p>
        ) : (
          <>
            <table className="w-full text-[13px]">
              <thead className="text-[var(--color-foreground-muted)]">
                <tr>
                  <th className="text-left font-normal py-1 w-1/2">URL pattern</th>
                  <th className="text-left font-normal py-1">Label</th>
                  <th className="w-24"></th>
                </tr>
              </thead>
              <tbody>
                {draftPatterns.map((p, idx) => (
                  <tr key={idx} className="border-t border-[var(--color-border-subtle)]">
                    <td className="py-2">
                      <input
                        value={p.pattern}
                        onChange={e => setPatternField(idx, 'pattern', e.target.value)}
                        placeholder="/admissions"
                        className="w-full bg-transparent border border-[var(--color-border-subtle)] rounded px-2 py-1 font-mono text-[12px]"
                      />
                    </td>
                    <td className="py-2">
                      <select
                        value={p.label}
                        onChange={e => setPatternField(idx, 'label', e.target.value)}
                        className="w-full bg-transparent border border-[var(--color-border-subtle)] rounded px-2 py-1"
                      >
                        <option value="">Pick a label…</option>
                        {labelOptions.map(l => (
                          <option key={l} value={l}>{l}</option>
                        ))}
                      </select>
                    </td>
                    <td className="py-2 text-right">
                      <button onClick={() => removePattern(idx)} className="text-[var(--color-error)] hover:underline">Remove</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-3 flex items-center gap-3">
              <button onClick={addEmptyPattern} className="text-[13px] text-[var(--color-accent)] hover:underline">+ Add pattern</button>
              <div className="flex-1" />
              {dirtyPatterns && (
                <button onClick={() => setDraftPatterns(patterns)} className="text-[13px] text-[var(--color-foreground-muted)] hover:underline">
                  Discard
                </button>
              )}
              <button
                onClick={savePatterns}
                disabled={!dirtyPatterns || savingPatterns}
                className="text-[13px] px-3 py-1 rounded bg-[var(--color-accent)] text-[var(--color-accent-foreground)] disabled:opacity-40"
              >
                {savingPatterns ? 'Saving…' : 'Save patterns'}
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
