// Per-request LLM provider resolution for the chat handlers.
//
// The browser's ProviderSwitcher (apps/chat/components/devpanl/) sends
// the user's choice as `x-devpanl-provider` on every chat turn, formatted
// `<provider>:<model>` (e.g. `deepinfra:Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo`).
// Both `chat.js` and `routes-dashboard-chat.js` need to honor it without
// re-implementing parsing + allowlist + provider construction. (DEVPA-213)
//
// Allowlist mirrors `apps/chat/components/devpanl/ProviderSwitcher.tsx`'s
// DEFAULT_PROVIDERS. Anything not in it falls back to env defaults with
// a warning — never trust an arbitrary header.
//
// Today: deepinfra + openai are wired (both via @ai-sdk/openai's
// createOpenAI with different baseURL/apiKey). anthropic + ollama are
// listed as accepted by the switcher but not yet plumbed — those choices
// fall back to env default until @ai-sdk/anthropic is added to the root
// deps (follow-up on DEVPA-213).

import { createOpenAI } from '@ai-sdk/openai';

const ALLOWLIST = new Set([
  'anthropic:claude-opus-4-7',
  'anthropic:claude-sonnet-4-6',
  'deepinfra:Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo',
  'openai:gpt-4o',
  'ollama:local',
]);

// Provider singletons — one per (kind, baseURL, apiKey) tuple. We don't
// need to build a fresh client per request; the OpenAI-compat factory is
// stateless once configured. Keyed by `kind:apiKey-fingerprint` so a
// future per-user key wouldn't share with the global default.
const cache = new Map();

function getOpenAICompat(kind) {
  const key = kind;
  if (cache.has(key)) return cache.get(key);

  const apiKey = kind === 'deepinfra'
    ? (process.env.DEEPINFRA_API_KEY ?? process.env.OPENAI_API_KEY)
    : process.env.OPENAI_API_KEY;
  const baseURL = kind === 'deepinfra'
    ? 'https://api.deepinfra.com/v1/openai'
    : undefined;

  const client = createOpenAI({ apiKey, baseURL });
  cache.set(key, client);
  return client;
}

function envDefault() {
  const provider = process.env.LLM_PROVIDER ?? 'deepinfra';
  const model = process.env.LLM_MODEL ?? (provider === 'openai'
    ? 'gpt-4o'
    : 'Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo');
  return { provider, model };
}

// Returns { model, provider } — an AI SDK LanguageModel and the provider
// kind so the caller can build a correct system prompt.
//
// The caller passes the raw header value (or null/undefined). On unknown
// or unsupported choices, falls back to env default and logs once per
// invalid value seen. Never throws — chat must keep working even with a
// stale browser sending an old provider id.
export function resolveChatModel(headerValue) {
  let providerKind;
  let modelName;

  if (typeof headerValue === 'string' && ALLOWLIST.has(headerValue)) {
    const colonAt = headerValue.indexOf(':');
    providerKind = headerValue.slice(0, colonAt);
    modelName = headerValue.slice(colonAt + 1);
  } else {
    if (headerValue) {
      console.warn(`[chat-providers] header value rejected: ${headerValue}`);
    }
    const env = envDefault();
    providerKind = env.provider;
    modelName = env.model;
  }

  switch (providerKind) {
    case 'deepinfra':
    case 'openai': {
      const client = getOpenAICompat(providerKind);
      return { model: client.chat(modelName), provider: providerKind };
    }
    case 'anthropic':
    case 'ollama': {
      // Not yet wired — @ai-sdk/anthropic isn't in root deps; ollama
      // baseURL plumbing is project work. Fall back to env default so
      // the chat keeps responding instead of 500-ing on a UI choice.
      console.warn(`[chat-providers] ${providerKind} not yet plumbed, falling back to env default`);
      const env = envDefault();
      providerKind = env.provider;
      modelName = env.model;
      const client = getOpenAICompat(providerKind === 'openai' ? 'openai' : 'deepinfra');
      return { model: client.chat(modelName), provider: providerKind };
    }
    default: {
      const env = envDefault();
      providerKind = env.provider;
      modelName = env.model;
      const client = getOpenAICompat(providerKind === 'openai' ? 'openai' : 'deepinfra');
      return { model: client.chat(modelName), provider: providerKind };
    }
  }
}
