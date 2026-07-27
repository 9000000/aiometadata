export interface AIModel {
  id: string;
  name: string;
  grounding: boolean;
}

export const GEMINI_MODELS: AIModel[] = [
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', grounding: true },
  { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', grounding: false },
  { id: 'gemini-3-flash', name: 'Gemini 3 Flash', grounding: false },
  { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash Lite', grounding: false },
  { id: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro', grounding: false },
  { id: 'gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash Lite', grounding: false },
  { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', grounding: false },
  { id: 'gemini-3.6-flash', name: 'Gemini 3.6 Flash', grounding: false },
];

export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';
export const DEFAULT_OPENROUTER_MODEL = 'google/gemini-2.5-flash';

// Retired by Google — rejected for API keys created after retirement.
export const RETIRED_GEMINI_MODELS: Record<string, string> = {
  'gemini-2.5-flash-lite': DEFAULT_GEMINI_MODEL,
  'gemini-2.5-flash-lite-preview-09-2025': DEFAULT_GEMINI_MODEL,
};

export function resolveGeminiModel(model?: string | null): string {
  if (!model) return DEFAULT_GEMINI_MODEL;
  return RETIRED_GEMINI_MODELS[model] || model;
}

export type AIProvider = 'gemini' | 'openrouter';

// An OpenRouter ID is always vendor/model, which keeps the two namespaces apart.
export function isModelIdForProvider(provider: AIProvider, model?: string | null): boolean {
  if (!model) return false;
  return provider === 'openrouter' ? model.includes('/') : !model.includes('/');
}

export function defaultModelFor(provider: AIProvider): string {
  return provider === 'openrouter' ? DEFAULT_OPENROUTER_MODEL : DEFAULT_GEMINI_MODEL;
}

// Mirrors resolveCatalogModel in addon/utils/ai-model-resolver.ts.
export function resolveCatalogModel(config: any, provider: AIProvider): string {
  const configured = provider === 'openrouter'
    ? config?.ai_catalog?.openrouter_model
    : config?.ai_catalog?.gemini_model;
  const inherited = config?.search?.ai_provider === provider ? config?.search?.ai_model : undefined;

  for (const candidate of [configured, inherited]) {
    if (!isModelIdForProvider(provider, candidate)) continue;
    return provider === 'openrouter' ? candidate : resolveGeminiModel(candidate);
  }

  return defaultModelFor(provider);
}
