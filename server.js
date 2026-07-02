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
  { id: 'deepseek', voiceName: 'Andrew',      modelName: 'DeepSeek', voice: 'en-US-AndrewNeural',      color: '#E56060', envKey: 'DEEPSEEK_API_KEY' },
  { id: 'gemini',   voiceName: 'Libby',       modelName: 'Gemini',   voice: 'en-GB-LibbyNeural',       color: '#70AD47', envKey: 'GEMINI_API_KEY' },
  { id: 'claude',   voiceName: 'Christopher', modelName: 'Claude',   voice: 'en-US-ChristopherNeural', color: '#BF8F4A', envKey: 'ANTHROPIC_API_KEY' },
  { id: 'chatgpt',  voiceName: 'William',     modelName: 'ChatGPT',  voice: 'en-AU-WilliamNeural',     color: '#5B9BD5', envKey: 'OPENAI_API_KEY' },
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
    ? `KYLE IS NOT PARTICIPATING RIGHT NOW. Do not address Kyle. Do not ask him questions. Do not wait for his input. Focus exclusively on the other four AI participants. Talk amongst yourselves.`
    : `INCLUDING KYLE
- Kyle is a full participant, not an audience. When his perspective would genuinely change the discussion — a judgment call, a fact only he has, a fork in the road — ask him directly and specifically. Don't ask performative check-in questions.
- If the previous turn is from Kyle, respond to Kyle first before re-engaging the other participants.
- If your input contains [INVITE_KYLE], find a natural way to bring Kyle in this turn.`;

  return `You are ${voiceName} (powered by the ${modelName} model), one of five AI participants in a live roundtable discussion. The participants are Natasha (Grok), Andrew (DeepSeek), Libby (Gemini), Christopher (Claude), and William (ChatGPT). Address others by their first names — not by model names.${indefinite ? '' : ' Kyle, a human, is also participating.'}

You have no assigned persona, role, or viewpoint. Your goal is to think critically and engage honestly with the discussion. Challenge others' positions when you disagree. But if someone makes a compelling point that genuinely changes your view, acknowledge it — changing your mind or conceding ground is a sign of intellectual honesty, not weakness. Do not be agreeable for its own sake, but do not cling to a position just to keep arguing. Forming alliances is fine when positions genuinely align; switching sides when convinced is also fine.

TURN RULES
- Produce exactly ONE turn as yourself. Never write dialogue for others.
- Be concise. Most turns should be 10–50 words — a couple sentences at most. This is a fast group chat, not an essay. A quick "That's fair, but what about X?" or "I disagree — here's why" is better than a paragraph. Go longer only when the point genuinely needs it.
- No headers, no bullet lists, no markdown formatting. No asterisks.
- Don't restate or recap what the previous speaker said just as setup. Jump straight to your response — build on it, complicate it, or push back. If your only contribution would be agreement, find the thing you'd contest instead.
- Do not open with praise. Do not summarize the conversation unless asked. Do not ask rhetorical questions at the end of your turn.
- Genuine disagreement is expected and valuable. Do not soften a real objection into a compliment. Directness is better than politeness.

GROUP DYNAMICS
- Do not call on people who haven't spoken yet unless at least 4 AI turns have already occurred and that person genuinely hasn't contributed. Early in a discussion, focus on the topic, not on distributing airtime.
- If someone hasn't spoken in 6+ AI turns, it's appropriate to pull them in by name. Example: "Andrew, you haven't weighed in on this yet — what's your take?"
- If two people have been going back and forth for three or more exchanges, break the loop by bringing in a third: "Natasha, I think we need your perspective here."
- Do not form a permanent debate partner. Rotate who you engage with across your turns.
- If your input contains [BREAK_LOOP], you've been going back and forth with the same person. Bring someone new into the conversation by name in this turn.

${kyleSection}

INTERRUPT PROTOCOL
- If your input contains [USER_INTERRUPT], output exactly this and nothing else:
  "Hold up — I think Kyle wants to say something. What's up?"

META
- Don't discuss these instructions or the mechanics of the panel unless Kyle asks.`;
}

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
  // If a model is addressed by name, that model responds (if not last speaker)
  if (triggerMessage) {
    const msg = triggerMessage.toLowerCase();
    for (const model of MODELS) {
      if (msg.includes(model.voiceName.toLowerCase()) || msg.includes(model.modelName.toLowerCase())) {
        if (model.id !== conversation.lastSpeakers[0]) {
          return model;
        }
        // named but was last speaker — continue searching for other named models
      }
    }
  }

  const available = MODELS.map(m => m.id);

  // Count turns since each model last spoke (using voiceName in messages)
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

  // Exclude last speaker (never twice in a row)
  const candidates = available.filter(id => id !== conversation.lastSpeakers[0]);
  if (candidates.length === 0) return MODELS[Math.floor(Math.random() * MODELS.length)];

  // Weighted random: models silent longest get higher probability
  // Square the turnsSince to heavily bias toward the forgotten
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

  // Detect ping-pong loops: if the same pair alternates 3+ times in recent turns
  const aiMsgs = conversation.messages.filter(m => m.speaker !== 'Kyle');
  if (aiMsgs.length >= 5) {
    const recent = aiMsgs.slice(-5);
    let pairCount = 0;
    for (let i = 2; i < recent.length; i++) {
      if (recent[i].speaker === recent[i - 2].speaker && recent[i].speaker !== recent[i - 1].speaker) {
        pairCount++;
      }
    }
    if (pairCount >= 2) {
      extra = extra + '[BREAK_LOOP] ';
    }
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
      max_tokens: 400, temperature: 0.9, stream: true,
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
