/**
 * API providers that speak the OpenAI chat-completions format. The addresses are fixed here, never
 * read from settings or a request, so a saved key can only go to its own provider.
 *
 * No model ids are listed: they change often, so the picker asks the provider (GET <base>/models)
 * once a key is set. `auto` never picks one of these; the person has to choose it.
 */
export const OPENAI_COMPAT = [
  { id: "openai-api", label: "OpenAI API key", env: "OPENAI_API_KEY", base: "https://api.openai.com/v1", maxField: "max_completion_tokens" },
  { id: "gemini-api", label: "Google Gemini API key", env: "GEMINI_API_KEY", base: "https://generativelanguage.googleapis.com/v1beta/openai", maxField: "max_tokens" },
  { id: "openrouter-api", label: "OpenRouter API key", env: "OPENROUTER_API_KEY", base: "https://openrouter.ai/api/v1", maxField: "max_tokens" },
  { id: "deepseek-api", label: "DeepSeek API key", env: "DEEPSEEK_API_KEY", base: "https://api.deepseek.com/v1", maxField: "max_tokens" },
  { id: "mistral-api", label: "Mistral API key", env: "MISTRAL_API_KEY", base: "https://api.mistral.ai/v1", maxField: "max_tokens" },
  { id: "groq-api", label: "Groq API key", env: "GROQ_API_KEY", base: "https://api.groq.com/openai/v1", maxField: "max_completion_tokens" },
  { id: "xai-api", label: "xAI (Grok) API key", env: "XAI_API_KEY", base: "https://api.x.ai/v1", maxField: "max_tokens" },
  { id: "zai-api", label: "Z.AI API key", env: "ZAI_API_KEY", base: "https://api.z.ai/api/paas/v4", maxField: "max_tokens" },
] as const;

export type OpenAiCompatProvider = (typeof OPENAI_COMPAT)[number];
export type OpenAiCompatId = OpenAiCompatProvider["id"];

export const findProvider = (id: string): OpenAiCompatProvider | undefined => OPENAI_COMPAT.find((p) => p.id === id);
