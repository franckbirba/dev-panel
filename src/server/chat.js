import { createOpenAI } from '@ai-sdk/openai';
import { experimental_createMCPClient as createMCPClient } from '@ai-sdk/mcp';
import { streamText, stepCountIs, convertToModelMessages } from 'ai';

const PROVIDER = process.env.LLM_PROVIDER ?? 'deepinfra';
const MODEL = process.env.LLM_MODEL ?? (PROVIDER === 'openai'
  ? 'gpt-4o'
  : 'Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo');

const provider = createOpenAI({
  apiKey: PROVIDER === 'deepinfra'
    ? (process.env.DEEPINFRA_API_KEY ?? process.env.OPENAI_API_KEY)
    : process.env.OPENAI_API_KEY,
  baseURL: PROVIDER === 'deepinfra'
    ? 'https://api.deepinfra.com/v1/openai'
    : undefined,
});

let mcpClient = null;
let cachedMCPTools = null;

async function getMCPTools() {
  if (cachedMCPTools) return cachedMCPTools;

  const url = process.env.DEVPANEL_MCP_URL ?? 'https://devpanl.dev/mcp';
  const token = process.env.ADMIN_API_KEY;
  if (!token) {
    console.warn('[chat] ADMIN_API_KEY missing — MCP tools disabled');
    return {};
  }

  try {
    mcpClient = await createMCPClient({
      transport: {
        type: 'http',
        url,
        headers: { Authorization: `Bearer ${token}` },
      },
    });
    cachedMCPTools = await mcpClient.tools();
    return cachedMCPTools;
  } catch (e) {
    console.warn('[chat] MCP connect failed:', e.message);
    return {};
  }
}

export function mountChat(app) {
  app.post('/api/chat', async (req, res) => {
    try {
      const { messages, system, tools } = req.body ?? {};
      const mcpTools = await getMCPTools();

      const result = streamText({
        model: provider.chat(MODEL),
        messages: await convertToModelMessages(messages ?? []),
        system,
        tools: { ...mcpTools },
        stopWhen: stepCountIs(8),
      });

      // Pipe AI SDK Data Stream Protocol response straight to Express
      const response = result.toUIMessageStreamResponse({ sendReasoning: true });
      res.status(response.status);
      response.headers.forEach((v, k) => res.setHeader(k, v));
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
      res.end();
    } catch (err) {
      console.error('[chat] handler error:', err);
      if (!res.headersSent) res.status(500).json({ error: err.message });
      else res.end();
    }
  });
}
