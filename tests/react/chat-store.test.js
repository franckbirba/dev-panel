// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { createChatStore, HISTORY_LIMIT } from '../../src/react/chat/chatStore.js';

describe('chatStore', () => {
  beforeEach(() => localStorage.clear());

  it('starts with empty defaults', () => {
    const store = createChatStore('s1');
    const s = store.getState();
    expect(s.messages).toEqual([]);
    expect(s.draft).toBe('');
    expect(s.isOpen).toBe(false);
    expect(s.bugMode).toBe(false);
    expect(s.connectionStatus).toBe('idle');
    expect(s.typing).toBe(false);
  });

  it('appendMessage adds to the message list', () => {
    const store = createChatStore('s1');
    store.getState().appendMessage({ id: 'm1', role: 'user', content: 'hello', ts: 1 });
    expect(store.getState().messages).toHaveLength(1);
    expect(store.getState().messages[0]).toMatchObject({ id: 'm1', content: 'hello' });
  });

  it(`keeps only the last ${50} messages`, () => {
    const store = createChatStore('s1');
    for (let i = 0; i < 60; i++) {
      store.getState().appendMessage({ id: `m${i}`, role: 'user', content: String(i), ts: i });
    }
    expect(HISTORY_LIMIT).toBe(50);
    expect(store.getState().messages).toHaveLength(50);
    expect(store.getState().messages[0].id).toBe('m10');
    expect(store.getState().messages.at(-1).id).toBe('m59');
  });

  it('persists state to localStorage keyed by session id', () => {
    const store = createChatStore('s1');
    store.getState().setDraft('hi');
    store.getState().appendMessage({ id: 'm1', role: 'user', content: 'hi', ts: 1 });
    store.getState().openDrawer();
    const raw = localStorage.getItem('devpanel.widget.chat.s1');
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw);
    expect(parsed.state.draft).toBe('hi');
    expect(parsed.state.isOpen).toBe(true);
    expect(parsed.state.messages).toHaveLength(1);
  });

  it('rehydrates persisted state on a fresh store with the same session id', () => {
    const a = createChatStore('s1');
    a.getState().appendMessage({ id: 'm1', role: 'user', content: 'hi', ts: 1 });
    a.getState().openDrawer();

    const b = createChatStore('s1');
    expect(b.getState().messages).toHaveLength(1);
    expect(b.getState().isOpen).toBe(true);
  });

  it('different session ids are isolated', () => {
    const a = createChatStore('s1');
    a.getState().appendMessage({ id: 'm1', role: 'user', content: 'hi', ts: 1 });

    const b = createChatStore('s2');
    expect(b.getState().messages).toHaveLength(0);
  });

  it('setBugMode toggles the bug compose flag', () => {
    const store = createChatStore('s1');
    store.getState().setBugMode(true);
    expect(store.getState().bugMode).toBe(true);
    store.getState().setBugMode(false);
    expect(store.getState().bugMode).toBe(false);
  });

  it('connectionStatus and typing setters update state', () => {
    const store = createChatStore('s1');
    store.getState().setConnectionStatus('open');
    expect(store.getState().connectionStatus).toBe('open');
    store.getState().setTyping(true);
    expect(store.getState().typing).toBe(true);
  });
});
