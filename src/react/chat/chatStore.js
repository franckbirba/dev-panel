import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

export const HISTORY_LIMIT = 50;

// Factory: each widget session gets its own store, persisted under a
// session-scoped key. The factory shape (vs a singleton) lets two widgets on
// the same page coexist and lets tests rebuild a fresh store per case.
export function createChatStore(sessionId) {
  return create(
    persist(
      (set, get) => ({
        messages: [],
        draft: '',
        isOpen: false,
        bugMode: false,
        connectionStatus: 'idle',
        typing: false,

        openDrawer: () => set({ isOpen: true }),
        closeDrawer: () => set({ isOpen: false }),
        toggleDrawer: () => set({ isOpen: !get().isOpen }),
        setDraft: (text) => set({ draft: text }),
        setBugMode: (on) => set({ bugMode: !!on }),
        appendMessage: (msg) => set((state) => {
          const next = [...state.messages, msg];
          return { messages: next.length > HISTORY_LIMIT ? next.slice(-HISTORY_LIMIT) : next };
        }),
        setTyping: (v) => set({ typing: !!v }),
        setConnectionStatus: (s) => set({ connectionStatus: s }),
        clearMessages: () => set({ messages: [] }),
      }),
      {
        name: `devpanel.widget.chat.${sessionId}`,
        storage: createJSONStorage(() => (typeof localStorage !== 'undefined' ? localStorage : undefined)),
        partialize: (state) => ({
          messages: state.messages,
          draft: state.draft,
          isOpen: state.isOpen,
          bugMode: state.bugMode,
        }),
      },
    ),
  );
}
