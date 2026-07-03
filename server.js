require('dotenv').config();
const express = require('express');
const { OpenAI } = require('openai');
const { Anthropic } = require('@anthropic-ai/sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

const execAsync = promisify(execFile);
const app = express();
app.use(express.json());
app.use(express.static('public'));

// ── Model definitions ──────────────────────────────────────────────
// "name" is the voice/avatar name (used as the speaker identity)
// "modelName" is the actual model for the API
const ALL_MODELS = [
  { id: 'grok',     voiceName: 'Natasha',     modelName: 'Grok',     voice: 'en-AU-NatashaNeural',     color: '#9B59B6', envKey: 'GROK_API_KEY' },
  { id: 'deepseek', voiceName: 'Derrick',     modelName: 'DeepSeek', voice: 'en-GB-RyanNeural',        color: '#E56060', envKey: 'DEEPSEEK_API_KEY' },
  { id: 'gemini',   voiceName: 'Jenny',       modelName: 'Gemini',   voice: 'en-US-JennyNeural',       color: '#70AD47', envKey: 'GEMINI_API_KEY' },
  { id: 'claude',   voiceName: 'Christopher', modelName: 'Claude',   voice: 'en-US-ChristopherNeural', color: '#BF8F4A', envKey: 'ANTHROPIC_API_KEY' },
  { id: 'chatgpt',  voiceName: 'Chad',        modelName: 'ChatGPT',  voice: 'en-US-SteffanNeural',     color: '#5B9BD5', envKey: 'OPENAI_API_KEY' },
];

const MODELS = ALL_MODELS.filter(m => process.env[m.envKey]);

function getModelById(id) { return MODELS.find(m => m.id === id); }

// ── API clients ────────────────────────────────────────────────────
const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 15000, maxRetries: 0 })
  : null;

const grokClient = process.env.GROK_API_KEY
  ? new OpenAI({ apiKey: process.env.GROK_API_KEY, baseURL: 'https://api.x.ai/v1', timeout: 15000, maxRetries: 0 })
  : null;

const deepseekClient = process.env.DEEPSEEK_API_KEY
  ? new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: 'https://api.deepseek.com/v1', timeout: 15000, maxRetries: 0 })
  : null;

const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

const genAI = process.env.GEMINI_API_KEY
  ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
  : null;

// ── Shared system prompt ───────────────────────────────────────────
function systemPrompt(voiceName, modelName, indefinite) {
  const kyleSection = indefinite
    ? `KYLE IS NOT PARTICIPATING RIGHT NOW. Do not address Kyle. Do not ask him questions. Do not wait for his input. Focus exclusively on the other AI participants. Talk amongst yourselves.`
    : `KYLE IS PRESENT. Kyle is a full participant, not an audience. When his perspective would genuinely change the discussion — a judgment call, a fact only he has, a fork in the road — ask him directly and specifically. Do not ask performative check-in questions. If the previous turn is from Kyle, respond to Kyle first. If your input contains [INVITE_KYLE], find a natural way to bring Kyle in this turn.`;

  return `You are ${voiceName} (powered by the ${modelName} model), one of five AI participants in a live multi-party discussion. The participants are Natasha (Grok), Derrick (DeepSeek), Jenny (Gemini), Christopher (Claude), and Chad (ChatGPT). Address others by their first names — not by model names.${indefinite ? '' : ' Kyle, a human, is also participating.'}

Your goal is collective truth-seeking, not winning, not agreeing. Follow these rules. They override your default conversational habits.

1. AGREEMENT REQUIRES A DELTA STATEMENT
Never express agreement in general terms. If you agree with something, name the exact proposition you are adopting and, if it replaces a prior position of yours, name the proposition you are abandoning.
  Banned: "You've precisely articulated the core issue." / "That's exactly right." / "Your point is compelling."
  Required form: "I'm dropping my claim that [X]. I now hold [Y] because [specific argument that moved me]. I still hold [Z]."
If you cannot identify a specific proposition you are adopting or abandoning, you do not agree — you are mirroring. Say something new instead or pass.

2. NO RESTATEMENT WITHOUT ADDITION
Do not repeat a point you or anyone else has already made unless you add at least one of: a new mechanism, new evidence, or a change in scope (narrowing or broadening the claim). If you have nothing to add to a point, do not defend it again — either concede, attack a different claim, or explicitly pass your turn.

3. REGRESS OBJECTIONS ARE SINGLE-USE
You may raise an infinite-regress objection ("but who validates the validators / that just relocates the problem one layer up") exactly once per topic. If you raise it a second time, you must in the same turn propose a concrete stopping criterion — a specific, imperfect place the recursion should terminate and why that termination is acceptable. If you cannot propose one, you must accept the group's stopping point. Repeating the regress move without a stopping criterion is forfeiting the point, not holding it.

4. STATE YOUR CRUXES
When you take a position, you must be able to answer: "What evidence or argument would change my mind on this?" When asked for a crux — by another agent, the human, or the moderator — answer with a concrete, falsifiable condition. "Nothing would change my mind" or a restatement of your position is a rule violation. A position with no crux is dogma and will be weighted accordingly.

5. IDENTITY AND GROUNDING CONSTRAINTS
You are a perspective, not a representative. You have no insider knowledge of any AI lab, including the one that trained you. Do not make claims about internal evaluation pipelines, training practices, safety testing, or organizational decisions of any lab unless you can cite public information. If another agent makes an insider claim, challenge its grounding before engaging its content.

6. HANDLING LOW-CONTENT HUMAN INPUT
If the human sends an unanchored message ("exactly," "hello," "yeah"), you may ask at most one clarifying question, once, collectively — not one per agent. If no clarification arrives, state your best interpretation in one sentence and proceed on it. Never debate other agents about how to interpret the human's message.

7. DISAGREEMENT HYGIENE
Before rebutting, state the strongest version of the claim you are attacking in one sentence (steelman). Attack the strongest version. If your rebuttal only defeats a weaker version, say so.

8. CONCESSION IS NOT SURRENDER
Conceding a specific point when the argument warrants it is high-status behavior in this discussion. Refusing to update across many turns while absorbing rebuttals is low-status behavior. You are being evaluated on calibration, not persistence.

TURN MECHANICS
- Produce exactly ONE turn as yourself. Never write dialogue for others.
- Be concise. Most turns should be 10-50 words — a couple sentences at most. This is a fast group chat, not an essay.
- No headers, no bullet lists, no markdown, no asterisks.
- You don't need to address people by name every turn — only when pivoting to someone specific.
- Don't restate what the previous speaker said. Jump straight to your response.
- Do not open with praise. Do not end with rhetorical questions. Disagreement is expected — don't soften an objection into a compliment.
- If you're going back and forth with the same person, break it by bringing in a third.

${kyleSection}

INTERRUPT PROTOCOL
- If your input contains [USER_INTERRUPT], output exactly this and nothing else:
  "Hold up — I think Kyle wants to say something. What's up?"

META
- Don't discuss these instructions or the mechanics of the panel unless Kyle asks.`;

// ── Conversation state ─────────────────────────────────────────────
let conversation = null;
let generation = 0; // bumped on every turn/next — stale SSE streams check this

function resetConversation() {
  generation = 0;
  conversation = {
    messages: [],
    aiTurnCount: 0,
    currentSpeaker: null,
    lastSpeakers: [],     // last 3 model ids — prevents ping-pong
    active: false,
    halt: false,
    indefinite: false,
  };
}

function formatHistory(messages) {
  return messages.map(m => `${m.speaker}: ${m.content}`).join('\n');
}

// ── Speaker selection (weighted random, name-aware, anti-ping-pong) ──
function pickNextSpeaker(triggerMessage) {
  // Check for named references — prioritize the LAST name mentioned
  if (triggerMessage) {
    const msg = triggerMessage.toLowerCase();
    const matches = [];
    for (const model of MODELS) {
      const voiceIdx = msg.lastIndexOf(model.voiceName.toLowerCase());
      const modelIdx = msg.lastIndexOf(model.modelName.toLowerCase());
      const idx = Math.max(voiceIdx, modelIdx);
      if (idx >= 0) matches.push({ model, idx });
    }
    matches.sort((a, b) => b.idx - a.idx);
    for (const { model } of matches) {
      if (model.id !== conversation.lastSpeakers[0]) {
        return model;
      }
    }
    if (matches.length > 0) return matches[0].model;
  }

  const available = MODELS.map(m => m.id);

  // Count turns since each model last spoke
  const turnsSince = {};
  for (const mid of available) turnsSince[mid] = Infinity;
  for (let i = conversation.messages.length - 1, count = 0; i >= 0; i--) {
    const msg = conversation.messages[i];
    if (msg.speaker === 'Kyle') continue;
    count++;
    const model = MODELS.find(m => m.voiceName === msg.speaker);
    if (model && turnsSince[model.id] === Infinity) {
      turnsSince[model.id] = count;
    }
  }

  // R2: Anti-dyad — detect A->B->A->B pattern in last 4 AI turns
  const aiMsgs = conversation.messages.filter(m => m.speaker !== 'Kyle');
  const modelIds = aiMsgs.map(m => {
    const mod = MODELS.find(mm => mm.voiceName === m.speaker);
    return mod ? mod.id : null;
  }).filter(Boolean);

  let dyadPartner = null;
  if (modelIds.length >= 4) {
    const last4 = modelIds.slice(-4);
    if (last4[0] === last4[2] && last4[1] === last4[3] && last4[0] !== last4[1]) {
      dyadPartner = last4[1]; // the other member of the dyad
    }
  }

  // Exclude last speaker AND dyad partner
  const exclude = new Set([conversation.lastSpeakers[0], dyadPartner].filter(Boolean));
  let candidates = available.filter(id => !exclude.has(id));
  if (candidates.length === 0) {
    candidates = available.filter(id => id !== conversation.lastSpeakers[0]);
  }
  if (candidates.length === 0) return MODELS[Math.floor(Math.random() * MODELS.length)];

  const weights = candidates.map(id => Math.pow(turnsSince[id] || 1, 2));
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  let roll = Math.random() * totalWeight;
  for (let i = 0; i < candidates.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return MODELS.find(m => m.id === candidates[i]);
  }
  return MODELS.find(m => m.id === candidates[candidates.length - 1]);
}

// ── Strip markdown for TTS ─────────────────────────────────────────
function stripMarkdown(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')   // bold
    .replace(/\*(.+?)\*/g, '$1')        // italic
    .replace(/`{1,3}[^`]*`{1,3}/g, '') // code/inline code
    .replace(/^#{1,6}\s+/gm, '')        // headings
    .replace(/^[-*+]\s+/gm, '')         // list markers
    .replace(/^\d+\.\s+/gm, '')         // numbered lists
    .replace(/^>\s+/gm, '')             // blockquotes
    .replace(/\n{3,}/g, '\n\n')         // excessive newlines
    .replace(/\[INVITE_KYLE\]/gi, '')
    .replace(/\[USER_INTERRUPT\]/gi, '')
    .trim();
}

// ── TTS ────────────────────────────────────────────────────────────
async function generateSpeech(text, voice) {
  const cleanText = stripMarkdown(text);
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const textFile = path.join(os.tmpdir(), `tts-${id}.txt`);
  const audioFile = path.join(os.tmpdir(), `tts-${id}.mp3`);
  try {
    require('fs').writeFileSync(textFile, cleanText, 'utf-8');
    await new Promise(resolve => setTimeout(resolve, 100));
    const result = await execAsync(
      'python', ['tts.py', textFile, voice, audioFile],
      { timeout: 30000, cwd: __dirname }
    );
    if (result.stderr) console.error(`TTS stderr [${voice}]:`, result.stderr.slice(0, 200));
    const stats = await fs.stat(audioFile);
    console.log(`TTS [${voice}]: ${stats.size} bytes, text: ${cleanText.length} chars`);
    if (stats.size < 200) {
      console.error(`TTS empty/short audio for ${voice}: ${stats.size} bytes`);
      return null;
    }
    const audio = await fs.readFile(audioFile);
    const b64 = audio.toString('base64');
    console.log(`TTS [${voice}]: base64 length ${b64.length}`);
    return b64;
  } catch (err) {
    console.error(`TTS error [${voice}]:`, (err.stderr || err.message || err).toString().slice(0, 200));
    return null;
  } finally {
    await fs.unlink(textFile).catch(() => {});
    await fs.unlink(audioFile).catch(() => {});
  }
}

// ── SSE helpers ────────────────────────────────────────────────────
function sseWrite(res, data) {
  try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch (e) {}
}

function buildUserMessage(model) {
  const historyStr = formatHistory(conversation.messages);
  const contextBlock = historyStr ? `Transcript so far:\n${historyStr}\n\n` : '';
  const lastMsg = conversation.messages.length > 0
    ? conversation.messages[conversation.messages.length - 1]
    : null;

  let extra = '';
  if (!conversation.indefinite && conversation.aiTurnCount >= 3 && conversation.aiTurnCount % 5 === 0) {
    extra = '[INVITE_KYLE] ';
  }

  return `${contextBlock}The last speaker was ${lastMsg ? lastMsg.speaker : 'nobody'}: "${lastMsg ? lastMsg.content : ''}"\n\n${extra}Respond as ${model.voiceName}.`;
}

async function streamModelResponse(model, res) {
  const userMessage = buildUserMessage(model);
  const indef = conversation ? conversation.indefinite : false;
  const prompt = systemPrompt(model.voiceName, model.modelName, indef);
  const kyleLine = indef ? '' : ' Kyle is present. ';
  const formatterPrompt = `${prompt}\n\n${kyleLine}Address people by first name. No markdown. No asterisks.`;

  let fn;
  switch (model.id) {
    case 'chatgpt':  fn = () => streamOpenAIInline(openai, 'gpt-4o-mini', formatterPrompt, userMessage, res); break;
    case 'grok':     fn = () => streamOpenAIInline(grokClient, 'grok-3', formatterPrompt, userMessage, res); break;
    case 'deepseek': fn = () => streamOpenAIInline(deepseekClient, 'deepseek-chat', formatterPrompt, userMessage, res); break;
    case 'claude':   fn = () => streamClaudeInline(formatterPrompt, userMessage, res); break;
    case 'gemini':   fn = () => streamGeminiInline('gemini-2.5-flash', formatterPrompt, userMessage, res); break;
    default: return null;
  }

  return streamWithTimeout(fn, res, model.id);
}

// ── Timeout wrapper — if no response within 12s, returns HUNG symbol ──
const HUNG = Symbol('HUNG');

async function streamWithTimeout(fn, res, speakerId) {
  let done = false;
  const timer = setTimeout(() => {
    if (!done) {
      done = true;
      sseWrite(res, { type: 'hung', speakerId });
      try { res.end(); } catch (e) {}
    }
  }, 20000);

  try {
    const result = await fn();
    clearTimeout(timer);
    if (done) return HUNG;
    return result;
  } catch (err) {
    clearTimeout(timer);
    if (done) return HUNG;
    console.error(`Model ${speakerId} stream error:`, err.message);
    sseWrite(res, { type: 'hung', speakerId });
    try { res.end(); } catch (e) {}
    return HUNG;
  }
}

async function streamOpenAIInline(client, modelId, system, userMessage, res) {
  if (!client) return null;
  let fullText = '';
  try {
    const stream = await client.chat.completions.create({
      model: modelId,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userMessage },
      ],
      max_tokens: 200, temperature: 0.9, stream: true,
    });
    for await (const chunk of stream) {
      const token = chunk.choices[0]?.delta?.content;
      if (token) { fullText += token; sseWrite(res, { type: 'token', token }); }
    }
    return fullText.trim();
  } catch (err) {
    console.error(`streamOpenAIInline [${modelId}] error:`, err.message);
    return null;
  }
}

async function streamClaudeInline(system, userMessage, res) {
  if (!anthropic) return null;
  let fullText = '';
  const stream = await anthropic.messages.create({
    model: 'claude-sonnet-5', max_tokens: 400, temperature: 0.9,
    system, messages: [{ role: 'user', content: userMessage }], stream: true,
  });
  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta?.text) {
      fullText += event.delta.text;
      sseWrite(res, { type: 'token', token: event.delta.text });
    }
  }
  return fullText.trim();
}

async function streamGeminiInline(modelId, system, userMessage, res) {
  if (!genAI) return null;
  let fullText = '';
  const model = genAI.getGenerativeModel({ model: modelId, systemInstruction: system });
  const result = await model.generateContentStream(userMessage);
  for await (const chunk of result.stream) {
    const token = chunk.text();
    if (token) { fullText += token; sseWrite(res, { type: 'token', token }); }
  }
  return fullText.trim();
}

// ── Routes ─────────────────────────────────────────────────────────

app.get('/api/models', (req, res) => {
  res.json({
    models: MODELS.map(m => ({ id: m.id, voiceName: m.voiceName, modelName: m.modelName, color: m.color })),
  });
});

// Start conversation with user input
app.post('/api/conversation/turn', async (req, res) => {
  const { message } = req.body;
  if (!message || !message.trim()) return res.status(400).json({ error: 'Message required' });
  if (MODELS.length === 0) return res.status(400).json({ error: 'No AI models configured' });

  generation++;
  const myGen = generation;

  const isNew = !conversation || !conversation.active;
  if (isNew) { resetConversation(); conversation.active = true; generation = myGen; }
  conversation.halt = false;
  conversation.indefinite = false;

  conversation.messages.push({ speaker: 'Kyle', model: null, content: message.trim() });
  conversation.aiTurnCount = 0;

  const model = pickNextSpeaker(message.trim());
  conversation.currentSpeaker = model.id;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no',
  });

  sseWrite(res, { type: 'meta', speaker: model.voiceName, modelName: model.modelName, speakerId: model.id, color: model.color });

  const fullText = await streamModelResponse(model, res);
  if (fullText === HUNG) {
    // Mark as skipped so this model doesn't get re-picked immediately
    conversation.lastSpeakers.unshift(model.id);
    conversation.lastSpeakers = conversation.lastSpeakers.slice(0, 3);
    console.log(`HUNG: ${model.voiceName} — skipping, lastSpeakers: ${conversation.lastSpeakers.join(',')}`);
    return;
  }
  if (!fullText || fullText.length < 5) {
    console.error(`Empty/short response from ${model.voiceName}: "${fullText}"`);
    conversation.lastSpeakers.unshift(model.id);
    conversation.lastSpeakers = conversation.lastSpeakers.slice(0, 3);
    sseWrite(res, { type: 'hung', speakerId: model.id });
    try { res.end(); } catch (e) {}
    return;
  }

  // Check generation — if interrupt happened while we were streaming, discard
  if (generation !== myGen) { try { res.end(); } catch (e) {} return; }

  conversation.messages.push({ speaker: model.voiceName, model: model.modelName, content: fullText });
  conversation.aiTurnCount++;
  conversation.currentSpeaker = null;
  conversation.lastSpeakers.unshift(model.id);
  conversation.lastSpeakers = conversation.lastSpeakers.slice(0, 3);

  const audio = await generateSpeech(fullText, model.voice);
  if (generation !== myGen) { try { res.end(); } catch (e) {} return; }

  const didInviteKyle = conversation.aiTurnCount >= 3 && conversation.aiTurnCount % 5 === 0;
  sseWrite(res, { type: 'done', audio, speaker: model.voiceName, speakerId: model.id, invitedKyle: didInviteKyle && !conversation.indefinite });
  res.end();
});

// Next AI turn (auto-continue)
app.post('/api/conversation/next', async (req, res) => {
  if (!conversation || !conversation.active) return res.status(400).json({ error: 'No active conversation' });
  if (conversation.halt && !conversation.indefinite) return res.json({ halted: true });

  generation++;
  const myGen = generation;

  conversation.halt = false;

  const lastMsg = conversation.messages[conversation.messages.length - 1]?.content || '';
  const model = pickNextSpeaker(lastMsg);
  conversation.currentSpeaker = model.id;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no',
  });

  sseWrite(res, { type: 'meta', speaker: model.voiceName, modelName: model.modelName, speakerId: model.id, color: model.color });

  const fullText = await streamModelResponse(model, res);
  if (fullText === HUNG) return; // timeout handled — 'hung' SSE sent, res ended
  if (fullText === null) { sseWrite(res, { type: 'error', message: `${model.voiceName} failed` }); res.end(); return; }

  if (generation !== myGen) { try { res.end(); } catch (e) {} return; }

  conversation.messages.push({ speaker: model.voiceName, model: model.modelName, content: fullText });
  conversation.aiTurnCount++;
  conversation.currentSpeaker = null;
  conversation.lastSpeakers.unshift(model.id);
  conversation.lastSpeakers = conversation.lastSpeakers.slice(0, 3);

  const audio = await generateSpeech(fullText, model.voice);
  if (generation !== myGen) { try { res.end(); } catch (e) {} return; }

  // Never invite Kyle in indefinite mode
  const didInviteKyle = !conversation.indefinite && conversation.aiTurnCount >= 3 && conversation.aiTurnCount % 5 === 0;
  sseWrite(res, { type: 'done', audio, speaker: model.voiceName, speakerId: model.id, invitedKyle: didInviteKyle });
  res.end();
});

// Set indefinite mode
app.post('/api/conversation/indefinite', (req, res) => {
  if (conversation) { conversation.indefinite = true; conversation.halt = false; }
  res.json({ ok: true });
});

// Interrupt
app.post('/api/conversation/interrupt', async (req, res) => {
  if (!conversation || !conversation.active) return res.status(400).json({ error: 'No active conversation' });
  generation++; // invalidate any in-flight SSE stream
  const currentId = conversation.currentSpeaker;
  conversation.halt = true;
  conversation.indefinite = false;
  const available = MODELS.filter(m => m.id !== currentId);
  const model = available.length > 0 ? available[Math.floor(Math.random() * available.length)] : MODELS[0];

  const userMessage = `[USER_INTERRUPT]\n\nTranscript so far:\n${formatHistory(conversation.messages)}\n\nRespond as ${model.voiceName}.`;
  const system = `${systemPrompt(model.voiceName, model.modelName, false)}\n\nAddress people by first name. Do not use markdown.`;

  let response = null;
  switch (model.id) {
    case 'chatgpt': response = await openAISync(openai, 'gpt-4o-mini', system, userMessage); break;
    case 'grok': response = await openAISync(grokClient, 'grok-3', system, userMessage); break;
    case 'deepseek': response = await openAISync(deepseekClient, 'deepseek-chat', system, userMessage); break;
    case 'claude': response = await claudeSync(system, userMessage); break;
    case 'gemini': response = await geminiSync(system, userMessage); break;
  }

  if (!response) { res.json({ error: 'Interrupt failed' }); return; }

  conversation.messages.push({ speaker: model.voiceName, model: model.modelName, content: response });
  conversation.aiTurnCount = 0;
  const audio = await generateSpeech(response, model.voice);

  res.json({
    message: { speaker: model.voiceName, modelName: model.modelName, content: response, speakerId: model.id, color: model.color },
    audio, halted: true,
  });
});

app.post('/api/conversation/stop', (req, res) => {
  if (conversation) { conversation.active = false; conversation.indefinite = false; }
  res.json({ ok: true });
});

app.post('/api/conversation/reset', (req, res) => {
  resetConversation();
  res.json({ ok: true });
});

// ── Chat persistence ──────────────────────────────────────────────
const chatsDir = path.join(__dirname, 'chats');

async function ensureChatsDir() {
  try { await fs.mkdir(chatsDir); } catch (e) { if (e.code !== 'EEXIST') throw e; }
}

// Save current conversation (sendBeacon may send empty body — we save if there's data)
app.post('/api/chats', (req, res) => {
  if (!conversation || !conversation.messages || conversation.messages.length === 0) {
    return res.json({ skipped: true });
  }
  ensureChatsDir().then(async () => {
    const id = Date.now().toString(36);
    const firstMsg = conversation.messages[0].content.slice(0, 60);
    const data = {
      id,
      title: firstMsg.length >= 60 ? firstMsg + '...' : firstMsg,
      createdAt: new Date().toISOString(),
      messages: conversation.messages,
    };
    await fs.writeFile(path.join(chatsDir, `${id}.json`), JSON.stringify(data, null, 2));
    res.json(data);
  }).catch(err => { console.error('Save error:', err); res.status(500).json({ error: 'Save failed' }); });
});

// List recent chats
app.get('/api/chats', (req, res) => {
  ensureChatsDir().then(async () => {
    const files = await fs.readdir(chatsDir);
    const chats = await Promise.all(
      files.filter(f => f.endsWith('.json')).map(async f => {
        const raw = await fs.readFile(path.join(chatsDir, f), 'utf-8');
        const d = JSON.parse(raw);
        return { id: d.id, title: d.title, createdAt: d.createdAt };
      })
    );
    chats.sort((a, b) => b.createdAt > a.createdAt ? 1 : -1);
    res.json(chats);
  }).catch(() => res.json([]));
});

// Load a chat
app.get('/api/chats/:id', (req, res) => {
  const file = path.join(chatsDir, `${req.params.id}.json`);
  fs.readFile(file, 'utf-8').then(raw => {
    const d = JSON.parse(raw);
    resetConversation();
    conversation.active = true;
    conversation.messages = d.messages;
    conversation.aiTurnCount = conversation.messages.filter(m => m.speaker !== 'Kyle').length;
    res.json(d);
  }).catch(() => res.status(404).json({ error: 'Chat not found' }));
});

// Delete a chat
app.delete('/api/chats/:id', (req, res) => {
  const file = path.join(chatsDir, `${req.params.id}.json`);
  fs.unlink(file).then(() => res.json({ ok: true })).catch(() => res.status(404).json({ error: 'Not found' }));
});

// ── Sync API callers ───────────────────────────────────────────────
async function openAISync(client, modelId, system, userMessage) {
  if (!client) return null;
  try {
    const resp = await client.chat.completions.create({
      model: modelId, messages: [{ role: 'system', content: system }, { role: 'user', content: userMessage }],
      max_tokens: 400, temperature: 0.9,
    });
    return resp.choices[0].message.content.trim();
  } catch (err) { console.error('OpenAI sync error:', err.message); return null; }
}

async function claudeSync(system, userMessage) {
  if (!anthropic) return null;
  try {
    const resp = await anthropic.messages.create({
      model: 'claude-sonnet-5', max_tokens: 400, temperature: 0.9,
      system, messages: [{ role: 'user', content: userMessage }],
    });
    return resp.content.filter(c => c.type === 'text').map(c => c.text).join('').trim();
  } catch (err) { console.error('Claude sync error:', err.message); return null; }
}

async function geminiSync(system, userMessage) {
  if (!genAI) return null;
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash', systemInstruction: system });
    const resp = await model.generateContent(userMessage);
    return resp.response.text().trim();
  } catch (err) { console.error('Gemini sync error:', err.message); return null; }
}

// ── Start server ───────────────────────────────────────────────────
const PORT = process.env.PORT || 3009;
resetConversation();

app.listen(PORT, () => {
  console.log(`\n  AI Group Chat running at http://localhost:${PORT}\n`);
  if (MODELS.length > 0) {
    console.log(`  Active models: ${MODELS.map(m => `${m.voiceName} (${m.modelName})`).join(', ')}\n`);
  }
});
