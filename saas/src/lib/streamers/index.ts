import OpenAI from 'openai';
import { Anthropic } from '@anthropic-ai/sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { ALL_MODELS, type ModelDef } from '@/lib/models';
import { resolveApiKey } from '@/lib/keys';
import { systemPrompt } from '@/lib/prompt';
import { sseWrite } from '@/lib/sse';

// Map of key -> client to avoid re-creating clients for the same key
const openaiClients = new Map<string, OpenAI>();
const grokClients = new Map<string, OpenAI>();
const deepseekClients = new Map<string, OpenAI>();
const anthropicClients = new Map<string, Anthropic>();
const genAIClients = new Map<string, GoogleGenerativeAI>();

function getOpenAI(key: string): OpenAI {
  if (!openaiClients.has(key)) {
    openaiClients.set(key, new OpenAI({ apiKey: key, timeout: 25000, maxRetries: 0 }));
  }
  return openaiClients.get(key)!;
}

function getGrok(key: string): OpenAI {
  if (!grokClients.has(key)) {
    grokClients.set(key, new OpenAI({ apiKey: key, baseURL: 'https://api.x.ai/v1', timeout: 25000, maxRetries: 0 }));
  }
  return grokClients.get(key)!;
}

function getDeepSeek(key: string): OpenAI {
  if (!deepseekClients.has(key)) {
    deepseekClients.set(key, new OpenAI({ apiKey: key, baseURL: 'https://api.deepseek.com/v1', timeout: 25000, maxRetries: 0 }));
  }
  return deepseekClients.get(key)!;
}

function getAnthropic(key: string): Anthropic {
  if (!anthropicClients.has(key)) {
    anthropicClients.set(key, new Anthropic({ apiKey: key }));
  }
  return anthropicClients.get(key)!;
}

function getGenAI(key: string): GoogleGenerativeAI {
  if (!genAIClients.has(key)) {
    genAIClients.set(key, new GoogleGenerativeAI(key));
  }
  return genAIClients.get(key)!;
}

export async function streamModelResponse(
  model: ModelDef,
  apiKey: string,
  userMessage: string,
  controller: ReadableStreamDefaultController,
  conversationId: string,
): Promise<string | null> {
  const prompt = systemPrompt(model.voiceName, model.modelName, false);
  const formatterPrompt = `${prompt}\n\nAddress people by first name. No markdown. No asterisks.`;

  switch (model.provider) {
    case 'openai':
      return streamOpenAI(getOpenAI(apiKey), model.modelApiId, formatterPrompt, userMessage, controller);
    case 'grok':
      return streamOpenAI(getGrok(apiKey), model.modelApiId, formatterPrompt, userMessage, controller);
    case 'deepseek':
      return streamOpenAI(getDeepSeek(apiKey), model.modelApiId, formatterPrompt, userMessage, controller);
    case 'anthropic':
      return streamClaude(getAnthropic(apiKey), formatterPrompt, userMessage, controller);
    case 'gemini':
      return streamGemini(getGenAI(apiKey), formatterPrompt, userMessage, controller);
    default:
      return null;
  }
}

async function streamOpenAI(
  client: OpenAI,
  modelId: string,
  system: string,
  userMessage: string,
  controller: ReadableStreamDefaultController,
): Promise<string> {
  const stream = await client.chat.completions.create({
    model: modelId,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: userMessage },
    ],
    max_tokens: 400, temperature: 0.9, stream: true,
  });
  let fullText = '';
  for await (const chunk of stream) {
    const token = chunk.choices[0]?.delta?.content;
    if (token) { fullText += token; sseWrite(controller, { type: 'token', token }); }
  }
  return fullText.trim();
}

async function streamClaude(
  client: Anthropic,
  system: string,
  userMessage: string,
  controller: ReadableStreamDefaultController,
): Promise<string> {
  const stream = await client.messages.create({
    model: 'claude-sonnet-5', max_tokens: 400, temperature: 0.9,
    system,
    messages: [{ role: 'user', content: userMessage }],
    stream: true,
  });
  let fullText = '';
  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta?.text) {
      fullText += event.delta.text;
      sseWrite(controller, { type: 'token', token: event.delta.text });
    }
  }
  return fullText.trim();
}

async function streamGemini(
  genAI: GoogleGenerativeAI,
  system: string,
  userMessage: string,
  controller: ReadableStreamDefaultController,
): Promise<string> {
  const genModel = genAI.getGenerativeModel({ model: 'gemini-2.5-flash', systemInstruction: system });
  const result = await genModel.generateContentStream(userMessage);
  let fullText = '';
  for await (const chunk of result.stream) {
    const token = chunk.text();
    if (token) { fullText += token; sseWrite(controller, { type: 'token', token }); }
  }
  return fullText.trim();
}
