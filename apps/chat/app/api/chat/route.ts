import { createOpenAI } from "@ai-sdk/openai";
import { frontendTools } from "@assistant-ui/react-ai-sdk";
import {
  type JSONSchema7,
  type ToolSet,
  streamText,
  stepCountIs,
  convertToModelMessages,
  type UIMessage,
} from "ai";
import { experimental_createMCPClient as createMCPClient } from "@ai-sdk/mcp";

export const maxDuration = 60;

const MCP_URL = process.env.DEVPANEL_MCP_URL ?? "https://devpanl.dev/mcp";
const MCP_TOKEN = process.env.ADMIN_API_KEY ?? "";

const PROVIDER = process.env.LLM_PROVIDER ?? "deepinfra";
const MODEL = process.env.LLM_MODEL ?? (PROVIDER === "openai"
  ? "gpt-4o"
  : "Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo");

const provider = createOpenAI({
  apiKey: PROVIDER === "deepinfra"
    ? (process.env.DEEPINFRA_API_KEY ?? process.env.OPENAI_API_KEY)
    : process.env.OPENAI_API_KEY,
  baseURL: PROVIDER === "deepinfra"
    ? "https://api.deepinfra.com/v1/openai"
    : undefined,
});

let mcpClient: Awaited<ReturnType<typeof createMCPClient>> | null = null;
let cachedMCPTools: ToolSet | null = null;

async function getMCPTools(): Promise<ToolSet> {
  if (cachedMCPTools) return cachedMCPTools;
  if (!MCP_TOKEN) {
    console.warn("ADMIN_API_KEY missing — MCP tools disabled");
    return {};
  }

  try {
    mcpClient = await createMCPClient({
      transport: {
        type: "http",
        url: MCP_URL,
        headers: { Authorization: `Bearer ${MCP_TOKEN}` },
      },
    });
    cachedMCPTools = await mcpClient.tools();
    return cachedMCPTools;
  } catch (e) {
    console.warn("Failed to connect to MCP server:", e);
    mcpClient = null;
    return {};
  }
}

export async function POST(req: Request) {
  const {
    messages,
    system,
    tools,
  }: {
    messages: UIMessage[];
    system?: string;
    tools?: Record<string, { description?: string; parameters: JSONSchema7 }>;
  } = await req.json();

  const mcpTools = await getMCPTools();

  const result = streamText({
    model: provider.chat(MODEL),
    messages: await convertToModelMessages(messages),
    system,
    tools: {
      ...mcpTools,
      ...frontendTools(tools ?? {}),
    },
    stopWhen: stepCountIs(8),
  });

  return result.toUIMessageStreamResponse({
    sendReasoning: true,
  });
}
