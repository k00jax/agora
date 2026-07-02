// Model definitions — shared between the Express app and Next.js API routes

export interface ModelDef {
  id: string;
  voiceName: string;
  modelName: string;
  modelApiId: string;
  voice: string;
  color: string;
  provider: 'openai' | 'anthropic' | 'gemini' | 'grok' | 'deepseek';
  creditMultiplier: number; // credits per 1K tokens
  envKey: string;
}

export const ALL_MODELS: ModelDef[] = [
  {
    id: 'grok', voiceName: 'Natasha', modelName: 'Grok', modelApiId: 'grok-3',
    voice: 'en-AU-NatashaNeural', color: '#9B59B6', provider: 'grok',
    creditMultiplier: 1.0, envKey: 'GROK_API_KEY',
  },
  {
    id: 'deepseek', voiceName: 'Andrew', modelName: 'DeepSeek', modelApiId: 'deepseek-chat',
    voice: 'en-US-AndrewNeural', color: '#E56060', provider: 'deepseek',
    creditMultiplier: 1.0, envKey: 'DEEPSEEK_API_KEY',
  },
  {
    id: 'gemini', voiceName: 'Libby', modelName: 'Gemini', modelApiId: 'gemini-2.5-flash',
    voice: 'en-GB-LibbyNeural', color: '#70AD47', provider: 'gemini',
    creditMultiplier: 0.5, envKey: 'GEMINI_API_KEY',
  },
  {
    id: 'claude', voiceName: 'Christopher', modelName: 'Claude', modelApiId: 'claude-sonnet-5',
    voice: 'en-US-ChristopherNeural', color: '#BF8F4A', provider: 'anthropic',
    creditMultiplier: 2.0, envKey: 'ANTHROPIC_API_KEY',
  },
  {
    id: 'chatgpt', voiceName: 'William', modelName: 'ChatGPT', modelApiId: 'gpt-4o-mini',
    voice: 'en-AU-WilliamNeural', color: '#5B9BD5', provider: 'openai',
    creditMultiplier: 1.0, envKey: 'OPENAI_API_KEY',
  },
];

export type KeySource = 'personal' | 'shared-pool' | 'unavailable';

export interface UserModel extends ModelDef {
  keySource: KeySource;
}
