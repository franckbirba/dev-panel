// src/dashboard/components/memory-write-modal.jsx
import { useState } from 'react';
import { IconClose } from './icons';

const KINDS = [
  { value: 'decision',       label: 'Decision' },
  { value: 'debug_finding',  label: 'Debug finding' },
  { value: 'handoff',        label: 'Handoff' },
  { value: 'retrospective',  label: 'Retrospective' },
  { value: 'spec_note',      label: 'Spec note' },
];

export function MemoryWriteModal({ open, onClose, apiUrl, onWritten }) {
  const [kind, setKind] = useState('decision');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [workItemId, setWorkItemId] = useState('');
  const [tags, setTags] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  if (!open) return null;

  const reset = () => {
    setKind('decision');
    setTitle('');
    setContent('');
    setWorkItemId('');
    setTags('');
    setError(null);
  };

  const submit = async () => {
    if (!title.trim() || !content.trim()) {
      setError('Title and content are required');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const body = {
        kind,
        title: title.trim(),
        content: content.trim(),
        agent: 'dashboard',
      };
      if (workItemId.trim()) body.work_item_id = workItemId.trim();
      if (tags.trim()) body.tags = tags.split(',').map(t => t.trim()).filter(Boolean);

      const res = await fetch(`${apiUrl}/memories`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `${res.status}`);
      }
      const data = await res.json();
      reset();
      onWritten?.(data);
      onClose();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="w-full max-w-lg rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-1)] shadow-xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 h-12 border-b border-[var(--color-border-subtle)]">
          <h2 className="text-[14px] font-semibold text-[var(--color-foreground)]">Write a memory</h2>
          <button onClick={onClose} className="p-1 hover:bg-[var(--color-surface-2)] rounded">
            <IconClose width={16} height={16} />
          </button>
        </div>

        <div className="p-4 flex flex-col gap-3">
          {error && (
            <div className="text-[13px] text-[var(--color-error)] bg-[var(--color-error-soft)] rounded-md px-3 py-2">
              {error}
            </div>
          )}

          <div className="flex gap-2">
            {KINDS.map(k => (
              <button
                key={k.value}
                onClick={() => setKind(k.value)}
                className={`px-2.5 py-1 rounded text-[11px] font-medium transition-colors ${
                  kind === k.value
                    ? 'bg-[var(--color-accent)] text-white'
                    : 'bg-[var(--color-surface-2)] text-[var(--color-foreground-muted)] hover:text-[var(--color-foreground)]'
                }`}
              >
                {k.label}
              </button>
            ))}
          </div>

          <input
            type="text"
            value={title}
            onChange={e => setTitle(e.target.value)}
            placeholder="Title"
            className="h-9 px-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] text-[13px] text-[var(--color-foreground)] placeholder:text-[var(--color-foreground-faint)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
          />

          <textarea
            value={content}
            onChange={e => setContent(e.target.value)}
            placeholder="Content — the actual insight, decision, or finding..."
            rows={4}
            className="px-3 py-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] text-[13px] text-[var(--color-foreground)] placeholder:text-[var(--color-foreground-faint)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)] resize-none"
          />

          <div className="flex gap-2">
            <input
              type="text"
              value={workItemId}
              onChange={e => setWorkItemId(e.target.value)}
              placeholder="Work item ID (optional)"
              className="flex-1 h-9 px-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] text-[13px] text-[var(--color-foreground)] placeholder:text-[var(--color-foreground-faint)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
            />
            <input
              type="text"
              value={tags}
              onChange={e => setTags(e.target.value)}
              placeholder="Tags (comma-separated)"
              className="flex-1 h-9 px-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] text-[13px] text-[var(--color-foreground)] placeholder:text-[var(--color-foreground-faint)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
            />
          </div>
        </div>

        <div className="flex justify-end gap-2 px-4 py-3 border-t border-[var(--color-border-subtle)]">
          <button
            onClick={onClose}
            className="h-8 px-3 rounded-md text-[13px] text-[var(--color-foreground-muted)] hover:bg-[var(--color-surface-2)] transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={saving}
            className="h-8 px-4 rounded-md text-[13px] font-medium bg-[var(--color-accent)] text-white hover:opacity-90 disabled:opacity-50 transition-opacity"
          >
            {saving ? 'Saving...' : 'Save memory'}
          </button>
        </div>
      </div>
    </div>
  );
}
