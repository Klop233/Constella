import type { ProviderApi } from "./models";

/** Common model services, to fill in the add-provider form; anything else is 自定义. */
export interface ProviderPreset {
  id: string;
  name: string;
  baseUrl: string;
  api: ProviderApi;
  /** Where to create an API key. */
  keyUrl?: string;
  /** Runs on the same server as Constella: no key needed, address seen from inside containers. */
  local?: boolean;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", api: "responses", keyUrl: "https://platform.openai.com/api-keys" },
  { id: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", api: "chat", keyUrl: "https://openrouter.ai/keys" },
  { id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", api: "chat", keyUrl: "https://platform.deepseek.com/api_keys" },
  { id: "moonshot", name: "Kimi", baseUrl: "https://api.moonshot.cn/v1", api: "chat", keyUrl: "https://platform.moonshot.cn/console/api-keys" },
  { id: "zhipu", name: "智谱", baseUrl: "https://open.bigmodel.cn/api/paas/v4", api: "chat" },
  { id: "dashscope", name: "通义千问", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", api: "chat" },
  { id: "ark", name: "火山方舟", baseUrl: "https://ark.cn-beijing.volces.com/api/v3", api: "chat" },
  { id: "siliconflow", name: "硅基流动", baseUrl: "https://api.siliconflow.cn/v1", api: "chat", keyUrl: "https://cloud.siliconflow.cn/account/ak" },
  { id: "newapi", name: "new-api", baseUrl: "http://host.docker.internal:3000/v1", api: "chat", local: true },
  { id: "cliproxy", name: "CLIProxyAPI", baseUrl: "http://host.docker.internal:8317/v1", api: "responses", local: true },
  { id: "ollama", name: "Ollama", baseUrl: "http://host.docker.internal:11434/v1", api: "chat", local: true },
];

export const API_LABEL: Record<ProviderApi, string> = { chat: "Chat Completions", responses: "Responses" };
