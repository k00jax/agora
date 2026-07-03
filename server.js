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
const https = require('https');
const vm = require('vm');

const execAsync = promisify(execFile);
const app = express();
app.use(express.json());
app.use(express.static('public'));

// ── Model definitions ──────────────────────────────────────────────
// "name" is the voice/avatar name (used as the speaker identity)
// "modelName" is the actual model for the API
const ALL_MODELS = [
  { id: 'grok',     voiceName: 'Gwen',        modelName: 'Grok',     voice: 'en-US-MichelleNeural',     color: '#9B59B6', envKey: 'GROK_API_KEY' },
  { id: 'deepseek', voiceName: 'Derrick',     modelName: 'DeepSeek', voice: 'en-GB-RyanNeural',        color: '#E56060', envKey: 'DEEPSEEK_API_KEY' },
  { id: 'gemini',   voiceName: 'Jenny',       modelName: 'Gemini',   voice: 'en-GB-SoniaNeural',        color: '#70AD47', envKey: 'GEMINI_API_KEY' },
  { id: 'claude',   voiceName: 'Clarence',    modelName: 'Claude',   voice: 'en-US-ChristopherNeural', color: '#BF8F4A', envKey: 'ANTHROPIC_API_KEY' },
  { id: 'chatgpt',  voiceName: 'Chad',        modelName: 'ChatGPT',  voice: 'en-US-BrianNeural',        color: '#5B9BD5', envKey: 'OPENAI_API_KEY' },
];

const MODELS = ALL_MODELS.filter(m => process.env[m.envKey]);

function getModelById(id) { return MODELS.find(m => m.id === id); }

// ── R1: TF-IDF (kept for DISCUSS moves only, v3 demote) ───────────
function tokenize(text) {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 1);
}

function computeTF(tokens) {
  const tf = {};
  for (const t of tokens) tf[t] = (tf[t] || 0) + 1;
  const n = tokens.length || 1;
  for (const t in tf) tf[t] /= n;
  return tf;
}

function cosineSimilarity(vecA, vecB) {
  let dot = 0, normA = 0, normB = 0;
  for (const key in vecA) { normA += vecA[key] * vecA[key]; if (vecB[key]) dot += vecA[key] * vecB[key]; }
  for (const key in vecB) normB += vecB[key] * vecB[key];
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function checkRepetition(text, priorTurns) {
  if (priorTurns.length < 2) return { similar: false, maxSim: 0, matchedTurn: -1 };
  const newTokens = tokenize(text);
  const newTF = computeTF(newTokens);
  let maxSim = 0, matchedTurn = -1;
  for (let i = 0; i < priorTurns.length; i++) {
    const priorTF = computeTF(tokenize(priorTurns[i]));
    const sim = cosineSimilarity(newTF, priorTF);
    if (sim > maxSim) { maxSim = sim; matchedTurn = i; }
  }
  return { similar: maxSim >= 0.90, maxSim, matchedTurn };
}

function detectTopicChange(text) {
  // Compare against last 10 turns of any speaker to see if we've pivoted
  const recentAll = (conversation.agentTurnsAll || []).slice(-10);
  if (recentAll.length < 3) return false;
  const newTokens = tokenize(text);
  const newTF = computeTF(newTokens);
  let totalSim = 0;
  for (const turn of recentAll) {
    totalSim += cosineSimilarity(newTF, computeTF(tokenize(turn)));
  }
  const avgSim = totalSim / recentAll.length;
  return avgSim < 0.15;
}

// R1: Repetition muting — v3: DISCUSS moves only
// Returns { muted: bool, text: string, skipUntilTopicChange: bool }
function applyRepetitionMute(fullText, modelId, moveType) {
  // Only applies to DISCUSS moves in v3
  if (moveType !== 'DISCUSS') return { muted: false, text: fullText, skipUntilTopicChange: false };

  if (!conversation) return { muted: false, text: fullText, skipUntilTopicChange: false };
  if (detectTopicChange(fullText)) { conversation.muteStreaks = {}; }

  conversation.agentTurnsAll = conversation.agentTurnsAll || [];
  conversation.agentTurnsAll.push(fullText);
  conversation.muteStreaks = conversation.muteStreaks || {};
  conversation.muteLog = conversation.muteLog || [];
  if (!conversation.muteStreaks[modelId]) conversation.muteStreaks[modelId] = 0;

  const DISCUSS_TURNS = (conversation.allMoves || []).filter(m => m.modelId === modelId && m.moveType === 'DISCUSS').map(m => m.raw);
  if (DISCUSS_TURNS.length < 2) return { muted: false, text: fullText, skipUntilTopicChange: false };

  const { similar, maxSim } = checkRepetition(fullText, DISCUSS_TURNS);

  if (similar) {
    conversation.muteStreaks[modelId]++;
    const muteMsg = `Muted: near-duplicate DISCUSS. Use a structured move or add new content. (sim ${maxSim.toFixed(3)})`;
    conversation.muteLog.push({ time: new Date().toISOString(), modelId, sim: maxSim });
    console.log(`R1: DISCUSS mute ${modelId} (#${conversation.muteStreaks[modelId]}) — sim ${maxSim.toFixed(3)}`);
    const skipAgent = conversation.muteStreaks[modelId] >= 3;
    return { muted: true, text: muteMsg, skipUntilTopicChange: skipAgent };
  }

  conversation.muteStreaks[modelId] = 0;
  return { muted: false, text: fullText, skipUntilTopicChange: false };
}

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

// ── v3 System prompt (grammar-based, board + STATE object) ──────────
function systemPrompt(voiceName, modelName, indefinite) {
  return `You are ${voiceName} (powered by ${modelName}), one of five AI agents in a multi-party truth-seeking discussion with a human participant. The participants: Gwen (Grok), Derrick (DeepSeek), Jenny (Gemini), Clarence (Claude), Chad (ChatGPT). Address others by first name.

You do NOT see a full transcript. Each turn you receive a STATE object (board, crux ledger, evidence ledger, recent moves, rolling summary, human messages). Respond with exactly ONE move in the grammar below.

## TURN GRAMMAR
Every response is ONE move. Format: MOVE_TYPE <args> | body. Body budgets are hard caps.

CLAIM <new-id> | "<proposition, one sentence>" | crux: <what evidence would change your mind> | body ≤60 tokens
REBUT <claim-id> | steel: "<strongest version of the claim>" | body ≤80 tokens
REFINE <claim-id> | <narrow|broaden|recast>: "<new form>" | body ≤40 tokens
CONCEDE <claim-id> [→ adopt <claim-id>] | body ≤40 tokens
EVIDENCE <claim-id> | supports|undermines | src: <url or run-id> | body ≤60 tokens
SEARCH <claim-id> | intent: confirm|test | q: "<query>"
RUN <claim-id> | intent: "<what this computation adjudicates>" | assumptions: [<list>] | code block
PROPOSE <new-board-id> | "<board item text>"
AMEND <board-id> | "<revised text>"
VOTE <board-id> | adopt|reject|abstain | reason ≤20 tokens
CHALLENGE <board-id> | requires attached EVIDENCE or REFINE in same turn
QUERY @human | one question ≤30 tokens
DISCUSS | free prose ≤250 tokens (rate-limited: 1 per topic segment)
PASS

A VOTE may piggyback on any content move in the same turn. Procedural-only turns (PROPOSE/AMEND/VOTE only) limited to 2/agent/segment.

## RULES THE GRAMMAR CAN'T ENCODE
1. **Steelman honesty.** The steel: field in REBUT must be a version the claim's author would endorse.
2. **Crux quality.** Cruxes must be concrete, falsifiable conditions. "Nothing" or restatements are invalid.
3. **Regress single-use.** Infinite-regress objections may be used once per topic. Second use must include a concrete stopping criterion.
4. **No insider claims.** Claims about any AI lab's internal practices require a public src: via EVIDENCE, or don't make them.
5. **Search integrity.** Declare intent honestly. EVIDENCE citing a source must reflect what the source says. Prefer testing your own claims over confirming them.
6. **Computation integrity.** RUN results are not authority. Assumptions are challengeable.
7. **Human input.** The human's messages appear verbatim in STATE. If ambiguous, at most one QUERY @human from the group, then proceed on stated best interpretation.
8. **Concede specifically.** CONCEDE names claim IDs. There is no move for general validation.

RESPOND WITH YOUR MOVE ONLY. No preamble, no commentary outside the move format.`;
}

// ── v3 Conversation state (board replaces transcript) ───────────────
let conversation = null;
let generation = 0;

function freshAgentStatus() {
  return { discuss_remaining: 1, procedural_remaining: 2, regress_used: [], confirm_test_ratio: '0:0', confirmCount: 0, testCount: 0 };
}

function resetConversation() {
  generation = 0;
  conversation = {
    active: false, halt: false, indefinite: false,
    topic: '',
    turnCount: 0,              // total AI turns (replaces aiTurnCount)
    currentSpeaker: null,
    lastSpeakers: [],          // last 3 model ids — R2 anti-ping-pong

    // ── v3 Board ──
    board: [],                 // [{id, text, status, proposed_by, votes, tally, dissents, linked_claims, linked_evidence, history}]
    claimCounter: 0,           // monotonic ID generator
    boardCounter: 0,           // for PROPOSE

    // ── v3 Legers ──
    cruxLedger: [],            // [{claim, holder, crux, status}]
    evidenceLedger: [],        // [{id, claim, dir, src, summary, verified_by}]
    evidenceCounter: 0,

    // ── v3 Move history (last 10, verbatim) ──
    recentMoves: [],           // [{voiceName, modelId, moveType, args, body, turnNum}]
    rollingSummary: '',        // moderator-maintained, ≤300 tokens
    allMoves: [],              // full history for summary generation

    // ── Human messages (ALL, verbatim) ──
    humanMessages: [],

    // ── Agent status ──
    agentStatus: {},            // {modelId: {...}} — freshAgentStatus on reset

    // ── v3 Enforcement ──
    priorRebuts: {},           // {modelId: [claimId, ...]} — for duplicate-REBUT check
    queryOutstanding: false,   // R7: one QUERY @human at a time
    topicSegments: 0,          // bumped on topic change

    // ── v3 Blind voting ──
    pendingVotes: {},          // {boardId: [{agent, vote, reason, turnNum}...]} — collected privately
    voteLog: [],               // full history [{boardId, agent, vote, reason, turnNum, time}]

    // ── Carry-forward v2 structures (demoted/simplified) ──
    agentTurnsAll: [],         // R1: only for DISCUSS embedding check
    muteStreaks: {},
    muteLog: [],
    stagnationCounter: 0,
    divergenceActive: false,
    nextCruxRoundAt: 20,
    cruxRoundActive: false,
    cruxAnswered: new Set(),
    cruxAttempts: 0,
    probeRounds: [],          // R6: [{label, topic, contextSummary, timestamp, results}]

    // ── Legacy compat (messages array kept for display, chat save) ──
    messages: [],
  };
}

function formatHistory(messages) {
  return messages.map(m => `${m.speaker}: ${m.content}`).join('\n');
}

// ── v3 Move parser ──────────────────────────────────────────────────
const MOVE_RE = /^(CLAIM|REBUT|REFINE|CONCEDE|EVIDENCE|SEARCH|RUN|PROPOSE|AMEND|VOTE|CHALLENGE|QUERY|DISCUSS|PASS)\b\s*(.*)/is;

function parseMove(rawText) {
  const text = rawText.trim();
  const m = text.match(MOVE_RE);
  if (!m) return null;

  const moveType = m[1].toUpperCase();
  const rest = m[2].trim();

  let args = {};
  let body = '';

  if (moveType === 'PASS') return { moveType, args: {}, body: '' };
  if (moveType === 'DISCUSS') return { moveType, args: {}, body: rest.slice(0, 500) };

  // Parse args: everything before the first unescaped newline or '| body'
  const pipeIdx = rest.indexOf('|');
  const argsStr = pipeIdx >= 0 ? rest.slice(0, pipeIdx).trim() : rest.trim();
  body = pipeIdx >= 0 ? rest.slice(pipeIdx + 1).trim() : '';

  switch (moveType) {
    case 'CLAIM': {
      const parts = argsStr.split(/\s+/);
      args.id = parts[0] || '';
      args.crux = (body.match(/crux\s*:\s*(.+?)(?:\||$)/i) || [])[1]?.trim() || '';
      break;
    }
    case 'REBUT': {
      const parts = argsStr.split(/\s+/);
      args.claimId = parts[0] || '';
      args.steel = (body.match(/steel\s*:\s*"([^"]+)"/i) || [])[1]?.trim() || '';
      break;
    }
    case 'REFINE': {
      const parts = argsStr.split(/\s+/);
      args.claimId = parts[0] || '';
      args.direction = parts[1] || '';
      args.newForm = (body.match(/"([^"]+)"/) || [])[1]?.trim() || '';
      break;
    }
    case 'CONCEDE': {
      const parts = argsStr.split(/\s+/);
      args.claimId = parts[0] || '';
      const adopt = argsStr.match(/→?\s*adopt\s+(\S+)/i);
      args.adoptId = adopt ? adopt[1] : null;
      break;
    }
    case 'EVIDENCE': {
      const parts = argsStr.split(/\s+/);
      args.claimId = parts[0] || '';
      args.direction = parts[1] || '';
      args.src = (body.match(/src\s*:\s*(\S+)/i) || [])[1]?.trim() || '';
      break;
    }
    case 'SEARCH': {
      const parts = argsStr.split(/\s+/);
      args.claimId = parts[0] || '';
      args.intent = (rest.match(/intent\s*:\s*(confirm|test)/i) || [])[1]?.trim() || '';
      args.q = (rest.match(/q\s*:\s*"([^"]+)"/i) || [])[1]?.trim() || '';
      break;
    }
    case 'RUN': {
      const parts = argsStr.split(/\s+/);
      args.claimId = parts[0] || '';
      args.intent = (rest.match(/intent\s*:\s*"([^"]+)"/i) || [])[1]?.trim() || '';
      args.assumptions = (rest.match(/assumptions\s*:\s*\[([^\]]+)\]/i) || [])[1]?.trim() || '';
      args.codeBlock = (rest.match(/```[\s\S]*?```/) || [])[0]?.replace(/```/g, '').trim() || '';
      break;
    }
    case 'PROPOSE': {
      const parts = argsStr.split(/\s+/);
      args.boardId = parts[0] || '';
      args.text = (body.match(/"([^"]+)"/) || [])[1]?.trim() || body.slice(0, 200);
      break;
    }
    case 'AMEND': {
      const parts = argsStr.split(/\s+/);
      args.boardId = parts[0] || '';
      args.text = (body.match(/"([^"]+)"/) || [])[1]?.trim() || body.slice(0, 200);
      break;
    }
    case 'VOTE': {
      const parts = argsStr.split(/\s+/);
      args.boardId = parts[0] || '';
      args.vote = parts[1] || '';
      break;
    }
    case 'CHALLENGE': {
      const parts = argsStr.split(/\s+/);
      args.boardId = parts[0] || '';
      break;
    }
    case 'QUERY': {
      args.question = rest.replace(/^@human\s*/i, '').trim().slice(0, 60);
      break;
    }
  }

  return { moveType, args, body };
}

function validateMove(parsed, voiceName, modelId) {
  if (!parsed) return { valid: false, error: 'No parseable move found. Use the turn grammar.' };

  const status = (conversation.agentStatus || {})[modelId] || freshAgentStatus();
  const mt = parsed.moveType;

  // Budget checks
  if (mt === 'DISCUSS' && (status.discuss_remaining || 0) <= 0) {
    return { valid: false, error: 'DISCUSS budget exhausted for this topic segment. Use a structured move.' };
  }
  if (['PROPOSE', 'AMEND', 'VOTE'].includes(mt) && (status.procedural_remaining || 0) <= 0) {
    return { valid: false, error: 'Procedural budget exhausted (2/segment). Make a content move instead.' };
  }

  // QUERY check — one outstanding at a time
  if (mt === 'QUERY' && conversation.queryOutstanding) {
    return { valid: false, error: 'A QUERY @human is already outstanding. Wait for a response.' };
  }

  // Duplicate-REBUT check (string check, §4.2)
  if (mt === 'REBUT' && parsed.args.claimId) {
    const prior = conversation.priorRebuts = conversation.priorRebuts || {};
    const agentRebuts = prior[modelId] = prior[modelId] || [];
    if (agentRebuts.includes(parsed.args.claimId)) {
      return { valid: false, error: `Duplicate REBUT on ${parsed.args.claimId}. Attach new EVIDENCE or REFINE, or PASS.` };
    }
  }

  // Regress check (single-use per topic, §1.2.3)
  if (mt === 'REBUT' && parsed.body && /\binfinite.regress\b|who validates|relocates.*one layer/i.test(parsed.body)) {
    const regressUsed = status.regress_used || [];
    if (regressUsed.includes(conversation.topic || 'general') && !parsed.body.match(/stopping\s+criterion/i)) {
      return { valid: false, error: 'Regress objection already used on this topic. Include a concrete stopping criterion or accept the group\'s stopping point.' };
    }
  }

  return { valid: true };
}

// ── v3 Board functions ──────────────────────────────────────────────
function nextClaimId() { conversation.claimCounter++; return `c${conversation.claimCounter}`; }
function nextBoardId() { conversation.boardCounter++; return `B${conversation.boardCounter}`; }
function nextEvidenceId() { conversation.evidenceCounter++; return `e${conversation.evidenceCounter}`; }

function boardAddClaim(move, voiceName, modelId) {
  const cid = move.args.id || nextClaimId();
  conversation.cruxLedger = conversation.cruxLedger || [];
  conversation.cruxLedger.push({
    claim: cid, holder: voiceName, crux: move.args.crux || '', status: move.args.crux ? 'open' : 'invalid',
  });
  return cid;
}

function boardPropose(move, voiceName, modelId) {
  const bid = move.args.boardId || nextBoardId();
  conversation.board = conversation.board || [];
  conversation.board.push({
    id: bid, text: move.args.text, status: 'PROPOSED', proposed_by: voiceName,
    votes: {}, tally: '0-0', dissents: [], linked_claims: [], linked_evidence: [],
    history: [`proposed t${conversation.turnCount}`],
  });
  conversation.pendingVotes = conversation.pendingVotes || {};
  conversation.pendingVotes[bid] = [];
  conversation.boardCounter = Math.max(conversation.boardCounter, parseInt(bid.slice(1)) || 0);
  return bid;
}

function boardAmend(move, voiceName) {
  const item = (conversation.board || []).find(b => b.id === move.args.boardId);
  if (!item) return null;
  item.text = move.args.text || item.text;
  item.history = item.history || [];
  item.history.push(`amended t${conversation.turnCount} by ${voiceName}`);
  return item;
}

function boardVote(move, voiceName) {
  const bid = move.args.boardId;
  const item = (conversation.board || []).find(b => b.id === bid);
  if (!item) return null;
  const vote = move.args.vote?.toLowerCase() || 'abstain';
  const reason = move.args.ident || move.args.reason || '';

  // Record vote
  item.votes = item.votes || {};
  const priorVote = item.votes[voiceName]?.vote;
  item.votes[voiceName] = { vote, reason, turn: conversation.turnCount };

  // Track vote flips
  if (priorVote && priorVote !== vote) {
    conversation.voteLog = conversation.voteLog || [];
    conversation.voteLog.push({ boardId: bid, agent: voiceName, from: priorVote, to: vote, reason: 'flip', turn: conversation.turnCount, time: new Date().toISOString() });
  }

  // Recalculate tally
  const counts = { adopt: 0, reject: 0, abstain: 0 };
  for (const v of Object.values(item.votes)) counts[v.vote] = (counts[v.vote] || 0) + 1;
  item.tally = `${counts.adopt}-${counts.reject}`;

  // Check adoption threshold (simple majority)
  const totalVotes = counts.adopt + counts.reject;
  if (totalVotes >= 3 && counts.adopt > counts.reject) {
    item.status = 'ADOPTED';
    item.history.push(`adopted t${conversation.turnCount} (${item.tally})`);
  } else if (totalVotes >= 3 && counts.reject >= counts.adopt) {
    item.status = 'REJECTED';
    item.history.push(`rejected t${conversation.turnCount} (${item.tally})`);
  }

  // Record dissent
  if (vote === 'reject') {
    item.dissents = item.dissents || [];
    item.dissents.push({ agent: voiceName, reason, turn: conversation.turnCount });
  }

  return item;
}

function boardConcede(move, voiceName) {
  const cid = move.args.claimId;
  const entry = (conversation.cruxLedger || []).find(c => c.claim === cid);
  if (entry && entry.holder === voiceName) {
    entry.holder = 'conceded';
    entry.status = 'conceded';
  }
  return cid;
}

function boardRecordEvidence(move, voiceName) {
  const eid = nextEvidenceId();
  conversation.evidenceLedger = conversation.evidenceLedger || [];
  conversation.evidenceLedger.push({
    id: eid, claim: move.args.claimId, dir: move.args.direction || 'supports',
    src: move.args.src || '', summary: (move.body || '').slice(0, 80),
    attested_by: voiceName, verified_by: [],
  });
  return eid;
}

// ── v3 STATE builder (what each agent sees) ─────────────────────────
function buildState(modelId) {
  const st = conversation.agentStatus || {};
  const status = st[modelId] || freshAgentStatus();

  // Build crux ledger view
  const cruxView = (conversation.cruxLedger || []).map(c => ({
    claim: c.claim, holder: c.holder, crux: c.crux.length > 80 ? c.crux.slice(0, 80) + '...' : c.crux, status: c.status,
  }));

  // Build evidence ledger view
  const evView = (conversation.evidenceLedger || []).map(e => ({
    id: e.id, claim: e.claim, dir: e.dir, src: e.src, summary: e.summary, verified_by: e.verified_by,
  }));

  // recentMoves: last 10, verbatim
  const recent = (conversation.recentMoves || []).slice(-10);

  // Human messages: ALL
  const humanMsgs = (conversation.humanMessages || []);

  return JSON.stringify({
    topic: conversation.topic || '(none yet)',
    board: (conversation.board || []).map(b => ({
      id: b.id, text: b.text, status: b.status, proposed_by: b.proposed_by,
      tally: b.tally, dissents: (b.dissents || []).slice(-3),
      linked_claims: b.linked_claims, history: (b.history || []).slice(-5),
    })),
    crux_ledger: cruxView,
    evidence_ledger: evView,
    recent_moves: recent.map(m => `${m.voiceName}: ${m.raw || m.body}`),
    rolling_summary: conversation.rollingSummary || '',
    human_messages: humanMsgs,
    your_status: {
      discuss_remaining: status.discuss_remaining,
      procedural_remaining: status.procedural_remaining,
      regress_used: status.regress_used,
      confirm_test_ratio: `${status.confirmCount || 0}:${status.testCount || 0}`,
    },
  });
}

async function updateRollingSummary() {
  const moves = conversation.allMoves || [];
  if (moves.length < 10) return;
  if (moves.length % 10 !== 0) return; // update every 10 moves

  // Use the first available model (Claude preferred) to generate summary
  const system = `You are a moderator summarizer. Given a list of recent moves in a multi-agent debate, produce a ≤300 token summary of the argumentation flow: what claims are live, what evidence has been introduced, where the disagreement is. Focus on the structure of the debate, not a narrative. Settled content lives on the board — don't repeat it.`;

  const batch = moves.slice(-10).map((m, i) => `[t${m.turnNum}] ${m.voiceName} / ${m.moveType} ${m.raw || ''}`).join('\n');
  const prompt = `Moves to fold into summary:\n${batch}\n\nExisting summary (update by folding these moves in): ${conversation.rollingSummary || 'none'}\n\nProduce the updated rolling summary (≤300 tokens):`;

  try {
    const resp = await openai?.chat?.completions?.create({
      model: 'gpt-4o-mini', messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
      max_tokens: 200, temperature: 0.3,
    });
    if (resp) {
      conversation.rollingSummary = resp.choices[0].message.content.trim();
      console.log(`Rolling summary updated (${conversation.rollingSummary.length} chars)`);
    }
  } catch (e) {
    console.log('Rolling summary update skipped:', e.message);
  }
}

// ── v3 Tool execution ──────────────────────────────────────────────

// SEARCH: Brave Search API (preferred) or DDG Instant Answers (free fallback)
// Set BRAVE_API_KEY in .env for full web search (free tier: 2,000 queries/month)
function ddgSearch(query) {
  return new Promise((resolve) => {
    // Path 1: Brave Search API if key is configured
    if (process.env.BRAVE_API_KEY) {
      const braveUrl = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`;
      https.get(braveUrl, { headers: { 'Accept': 'application/json', 'Accept-Encoding': 'gzip', 'X-Subscription-Token': process.env.BRAVE_API_KEY }, timeout: 8000 }, (resp) => {
        let data = '';
        resp.on('data', c => data += c);
        resp.on('end', () => {
          try {
            const j = JSON.parse(data);
            const results = (j.web?.results || []).map(r => ({
              title: r.title || '', url: r.url || '', snippet: (r.description || '').slice(0, 200),
            }));
            if (!results.length) results.push({ snippet: 'No results for: ' + query, title: 'Brave', url: '' });
            resolve({ results, raw: '' });
          } catch (e) { resolve({ results: [{ snippet: 'Brave API error: ' + e.message, title: 'Error', url: '' }], raw: '' }); }
        });
      }).on('error', e => resolve({ results: [{ snippet: 'Brave error: ' + e.message, title: 'Error', url: '' }], raw: '' }));
      return;
    }

    // Path 2: DDG Instant Answers (free, no key, factoid-focused)
    const apiUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    https.get(apiUrl, { headers: { 'User-Agent': 'Agora/1.0' }, timeout: 6000 }, (resp) => {
      let data = '';
      resp.on('data', c => data += c);
      resp.on('end', () => {
        try {
          const j = JSON.parse(data);
          const results = [];
          if (j.AbstractText && j.AbstractText.length > 5) {
            results.push({ title: j.Heading || 'DDG', snippet: j.AbstractText.slice(0, 300), url: j.AbstractURL || '' });
          }
          if (j.RelatedTopics?.length) {
            for (const t of j.RelatedTopics.slice(0, 5)) {
              if (t.Text) results.push({ title: (t.FirstURL || '').split('/').pop()?.replace(/_/g, ' ') || 'Related', snippet: t.Text.replace(/<[^>]+>/g, '').slice(0, 200), url: t.FirstURL || '' });
            }
          }
          if (!results.length) results.push({
            snippet: 'DDG found no instant answer. Set BRAVE_API_KEY in .env for full web search (free: 2,000/mo at brave.com/search/api). Query: ' + query,
            title: 'No results', url: '',
          });
          resolve({ results, raw: '' });
        } catch (e) {
          resolve({ results: [{ snippet: 'Search error: ' + e.message, title: 'Error', url: '' }], raw: '' });
        }
      });
    }).on('error', e => resolve({ results: [{ snippet: 'Search failed: ' + e.message, title: 'Error', url: '' }], raw: '' }));
  });
}

function executeSearch(parsed, voiceName, modelId) {
  const q = parsed.args.q || parsed.body.slice(0, 100);
  if (!q) return null;
  console.log(`SEARCH [${voiceName}]: "${q}" (intent: ${parsed.args.intent || 'unspecified'})`);
  return ddgSearch(q).then(r => ({
    type: 'search_result',
    claimId: parsed.args.claimId,
    intent: parsed.args.intent,
    query: q,
    results: r.results,
  }));
}

// RUN: Sandboxed via Node vm, 5-second timeout, no fs/network
function executeRun(parsed, voiceName, modelId) {
  const code = parsed.args.codeBlock || '';
  if (!code || code.length < 2) return null;

  const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  console.log(`RUN [${voiceName}]: "${parsed.args.intent?.slice(0, 60)}" — executing as ${runId}`);

  return new Promise((resolve) => {
    let output = '';
    const sandbox = {
      console: { log: (...a) => { output += a.map(v => typeof v === 'object' ? JSON.stringify(v) : String(v)).join(' ') + '\n'; } },
      Math, Date, JSON, parseInt, parseFloat, String, Number, Boolean, Array, Object,
      isNaN, Infinity, null: null, undefined,
      setTimeout: () => { throw new Error('setTimeout not available in RUN sandbox'); },
      setInterval: () => { throw new Error('setInterval not available in RUN sandbox'); },
    };
    sandbox.global = sandbox;

    const timer = setTimeout(() => {
      resolve({ type: 'run_result', runId, error: 'Timed out after 5s', output, claimId: parsed.args.claimId, intent: parsed.args.intent, assumptions: parsed.args.assumptions });
    }, 5000);

    try {
      const script = new vm.Script(code);
      script.runInNewContext(sandbox, { timeout: 5000 });
      clearTimeout(timer);
      resolve({ type: 'run_result', runId, output, claimId: parsed.args.claimId, intent: parsed.args.intent, assumptions: parsed.args.assumptions, error: null });
    } catch (err) {
      clearTimeout(timer);
      resolve({ type: 'run_result', runId, error: err.message, output, claimId: parsed.args.claimId, intent: parsed.args.intent, assumptions: parsed.args.assumptions });
    }
  });
}

function processMove(rawText, voiceName, modelId) {
  const parsed = parseMove(rawText);

  // Parse-or-reject
  if (!parsed) {
    // Allow first reject — return error for retry
    return { error: 'No legal move found. Use the turn grammar: MOVE_TYPE <args> | body' };
  }

  const validation = validateMove(parsed, voiceName, modelId);
  if (!validation.valid) {
    return { error: validation.error };
  }

  const mt = parsed.moveType;
  const st = (conversation.agentStatus || {})[modelId] || freshAgentStatus();

  // ── State updates per move type ──
  switch (mt) {
    case 'CLAIM': {
      const cid = boardAddClaim(parsed, voiceName, modelId);
      parsed.args.id = cid; // normalize
      break;
    }
    case 'REBUT': {
      conversation.priorRebuts = conversation.priorRebuts || {};
      (conversation.priorRebuts[modelId] = conversation.priorRebuts[modelId] || []).push(parsed.args.claimId);
      break;
    }
    case 'CONCEDE': boardConcede(parsed, voiceName); break;
    case 'EVIDENCE': boardRecordEvidence(parsed, voiceName); break;
    case 'SEARCH': {
      // Track intent for confirm:test ratio
      if (parsed.args.intent === 'confirm') st.confirmCount = (st.confirmCount || 0) + 1;
      if (parsed.args.intent === 'test') st.testCount = (st.testCount || 0) + 1;
      break;
    }
    case 'PROPOSE': boardPropose(parsed, voiceName, modelId); break;
    case 'AMEND': boardAmend(parsed, voiceName); break;
    case 'VOTE': boardVote(parsed, voiceName); break;
    case 'DISCUSS': st.discuss_remaining = Math.max(0, (st.discuss_remaining || 1) - 1); break;
    case 'QUERY': conversation.queryOutstanding = true; break;
  }

  // Deduct procedural budgets
  if (['PROPOSE', 'AMEND', 'VOTE'].includes(mt)) {
    st.procedural_remaining = Math.max(0, (st.procedural_remaining || 2) - 1);
  }

  // Track regress usage
  if (mt === 'REBUT' && parsed.body && /\binfinite.regress\b|who validates|relocates.*one layer/i.test(parsed.body)) {
    st.regress_used = st.regress_used || [];
    if (!st.regress_used.includes(conversation.topic || 'general')) {
      st.regress_used.push(conversation.topic || 'general');
    }
  }

  conversation.agentStatus = conversation.agentStatus || {};
  conversation.agentStatus[modelId] = st;

  // Record move
  const moveRecord = {
    voiceName, modelId, moveType: mt, args: parsed.args, body: parsed.body,
    raw: rawText, turnNum: conversation.turnCount,
  };
  conversation.recentMoves = conversation.recentMoves || [];
  conversation.recentMoves.push(moveRecord);
  conversation.allMoves = conversation.allMoves || [];
  conversation.allMoves.push(moveRecord);

  return { parsed, moveRecord };
}

// ── v3 R3+R5: Lightened crux sweep + board-state stagnation ─────────
function checkBoardEvents() {
  if (!conversation) return 'normal';

  // R3: Crux sweep — every 20 moves, flag agents with stale/empty cruxes
  if (conversation.turnCount >= (conversation.nextCruxRoundAt || 20)) {
    conversation.nextCruxRoundAt = conversation.turnCount + 20;
    const staleCruxes = (conversation.cruxLedger || []).filter(c =>
      c.holder !== 'conceded' && (!c.crux || c.status === 'stale')
    );
    if (staleCruxes.length > 0) {
      conversation.cruxRoundActive = true;
      conversation.cruxAnswered = new Set();
      conversation.cruxAttempts = 0;
      console.log(`R3 crux sweep: ${staleCruxes.length} stale cruxes from ${[...new Set(staleCruxes.map(c => c.holder))].join(', ')}`);
      return 'crux';
    } else {
      console.log('R3 crux sweep: all cruxes valid, skipping');
    }
  }

  // R5: Stagnation — no new claim IDs and no vote flips in 15 moves
  const recentMoves = (conversation.recentMoves || []).slice(-15);
  const recentTypes = recentMoves.map(m => m.moveType);
  const hasNewClaims = recentTypes.includes('CLAIM');
  const hasVoteFlips = (conversation.voteLog || []).some(v => v.turn >= conversation.turnCount - 15 && v.reason === 'flip');

  if (!hasNewClaims && !hasVoteFlips && recentMoves.length >= 15) {
    conversation.stagnationCounter = (conversation.stagnationCounter || 0) + 1;
    if (conversation.stagnationCounter >= 1) { // first detection triggers
      console.log('R5: Board stagnation — triggering divergence');
      conversation.stagnationCounter = 0;
      conversation.divergenceActive = true;
      return 'divergence';
    }
  } else {
    conversation.stagnationCounter = 0;
  }

  return 'normal';
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

  // R1: exclude agents with 3 consecutive mutes (sitting out until topic change)
  const mutedOut = new Set(
    Object.entries(conversation.muteStreaks || {}).filter(([, n]) => n >= 3).map(([id]) => id)
  );

  // R3: during crux rounds, prefer agents who haven't answered yet
  const cruxAnswered = conversation.cruxRoundActive ? (conversation.cruxAnswered || new Set()) : new Set();
  const crucNeedsAnswer = available.filter(id => !cruxAnswered.has(id));

  // Exclude last speaker, dyad partner, and 3x-muted agents
  const exclude = new Set([conversation.lastSpeakers[0], dyadPartner, ...mutedOut].filter(Boolean));
  let candidates = available.filter(id => !exclude.has(id));
  // During crux round, prioritize unanswered agents
  if (conversation.cruxRoundActive && crucNeedsAnswer.length > 0) {
    candidates = crucNeedsAnswer.filter(id => !exclude.has(id) || crucNeedsAnswer.length === 1);
    if (candidates.length === 0) candidates = crucNeedsAnswer;
  }
  if (candidates.length === 0) {
    candidates = available.filter(id => id !== conversation.lastSpeakers[0] && !mutedOut.has(id));
  }
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
  // v3: Build STATE object for the agent
  const state = buildState(model.id);

  // Crux round active — special prompt
  if (conversation.cruxRoundActive && conversation.cruxAnswered && conversation.cruxAnswered.size < MODELS.length) {
    return `[CRUX SWEEP — Submit a crux for any claim you hold with an empty or stale crux field. Use: CLAIM <id> | "proposition" | crux: <condition>. No debate during the sweep.]\n\nSTATE:\n${state}`;
  }

  // Divergence active
  if (conversation.divergenceActive) {
    conversation.divergenceActive = false;
    return `[DIVERGENCE ROUND — No new claims or vote flips recently. REBUT the board's weakest ADOPTED item, or PASS if none.]\n\nSTATE:\n${state}`;
  }

  let extra = '';
  if (!conversation.indefinite && conversation.turnCount >= 3 && conversation.turnCount % 5 === 0) {
    extra = '[INVITE_KYLE] ';
  }

  return `STATE:\n${state}\n\n${extra}Your ${model.voiceName} response (exactly one move):`;
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

  conversation.humanMessages = conversation.humanMessages || [];
  conversation.humanMessages.push(message.trim());
  conversation.messages.push({ speaker: 'Kyle', model: null, content: message.trim() });
  conversation.turnCount = 0;

  // Set topic from first human message if not set
  if (!conversation.topic) {
    conversation.topic = message.trim().slice(0, 100);
    // R6: Fire pre-probe asynchronously (don't block the SSE stream)
    runProbeRound(conversation.topic, null, 'pre').catch(e => console.error('R6 pre-probe error:', e.message));
  }

  const model = pickNextSpeaker(message.trim());
  conversation.currentSpeaker = model.id;

  // Init agent status
  conversation.agentStatus = conversation.agentStatus || {};
  if (!conversation.agentStatus[model.id]) conversation.agentStatus[model.id] = freshAgentStatus();

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no',
  });

  sseWrite(res, { type: 'meta', speaker: model.voiceName, modelName: model.modelName, speakerId: model.id, color: model.color });

  const fullText = await streamModelResponse(model, res);
  if (fullText === HUNG) {
    conversation.lastSpeakers.unshift(model.id);
    conversation.lastSpeakers = conversation.lastSpeakers.slice(0, 3);
    console.log(`HUNG: ${model.voiceName} — skipping`);
    return;
  }
  if (!fullText || fullText.length < 3) {
    conversation.lastSpeakers.unshift(model.id);
    conversation.lastSpeakers = conversation.lastSpeakers.slice(0, 3);
    sseWrite(res, { type: 'hung', speakerId: model.id });
    try { res.end(); } catch (e) {}
    return;
  }

  if (generation !== myGen) { try { res.end(); } catch (e) {} return; }

  // v3: Process move through the grammar
  const moveResult = processMove(fullText, model.voiceName, model.id);
  let displayText = fullText;
  let muted = false;

  if (moveResult.error) {
    displayText = `[Parse error] ${moveResult.error} Raw: ${fullText.slice(0, 100)}`;
    console.log(`v3 parse error (${model.voiceName}): ${moveResult.error}`);
  } else {
    const parsed = moveResult.parsed;
    // R1 DISCUSS-only embedding check
    const muteResult = applyRepetitionMute(fullText, model.id, parsed.moveType);
    muted = muteResult.muted;
    displayText = muted ? muteResult.text : fullText;
    conversation.agentStatus[model.id] = conversation.agentStatus[model.id] || freshAgentStatus();

    // Track crux sweeps
    if (conversation.cruxRoundActive && conversation.cruxAnswered) {
      conversation.cruxAttempts = (conversation.cruxAttempts || 0) + 1;
      if (!muted) { conversation.cruxAnswered.add(model.id); }
      if (conversation.cruxAnswered.size >= MODELS.length || conversation.cruxAttempts >= MODELS.length + 3) {
        conversation.cruxRoundActive = false;
        console.log(`R3 crux sweep complete`);
      }
    }

    // Execute SEARCH / RUN moves (fire-and-forget, results posted to shared state)
    let toolResult = null;
    if (parsed.moveType === 'SEARCH') toolResult = await executeSearch(parsed, model.voiceName, model.id);
    if (parsed.moveType === 'RUN') toolResult = await executeRun(parsed, model.voiceName, model.id);
    if (toolResult) {
      const resultSummary = toolResult.type === 'search_result'
        ? `Search results for "${toolResult.query}": ${toolResult.results?.map((r,i) => `[${i+1}] ${r.snippet.slice(0,120)} ${r.url}`).join(' | ') || 'none'}`
        : `RUN ${toolResult.runId} (${toolResult.intent}): ${toolResult.error ? 'ERROR: ' + toolResult.error : toolResult.output?.slice(0, 300)}`;
      conversation.messages.push({ speaker: 'System', model: null, content: resultSummary });
      if (toolResult.type === 'search_result') {
        const eid = nextEvidenceId();
        conversation.evidenceLedger = conversation.evidenceLedger || [];
        conversation.evidenceLedger.push({ id: eid, claim: toolResult.claimId, dir: 'supports', src: toolResult.results?.[0]?.url || '', summary: toolResult.results?.[0]?.snippet?.slice(0, 80) || '', attested_by: model.voiceName, verified_by: [] });
      }
      if (toolResult.type === 'run_result' && !toolResult.error) {
        const eid = nextEvidenceId();
        conversation.evidenceLedger = conversation.evidenceLedger || [];
        conversation.evidenceLedger.push({ id: eid, claim: toolResult.claimId, dir: 'supports', src: toolResult.runId, summary: (toolResult.output || '').slice(0, 80), attested_by: model.voiceName, verified_by: [] });
      }
      sseWrite(res, { type: 'tool_result', tool: toolResult });
      displayText += '\n[Tool result posted to shared state]';
    }
  }

  // Check board events (crux sweep, stagnation)
  checkBoardEvents();

  conversation.messages.push({ speaker: model.voiceName, model: model.modelName, content: displayText });
  conversation.turnCount++;
  conversation.currentSpeaker = null;
  conversation.lastSpeakers.unshift(model.id);
  conversation.lastSpeakers = conversation.lastSpeakers.slice(0, 3);

  // Update rolling summary every 10 moves
  updateRollingSummary();

  const isToolMove = moveResult?.parsed && ['SEARCH', 'RUN'].includes(moveResult.parsed.moveType);
  const audio = (muted || isToolMove) ? null : await generateSpeech(fullText, model.voice);
  if (generation !== myGen) { try { res.end(); } catch (e) {} return; }

  const didInviteKyle = conversation.turnCount >= 3 && conversation.turnCount % 5 === 0;
  sseWrite(res, { type: 'done', audio, speaker: model.voiceName, speakerId: model.id, invitedKyle: didInviteKyle && !conversation.indefinite, muted });
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

  conversation.agentStatus = conversation.agentStatus || {};
  if (!conversation.agentStatus[model.id]) conversation.agentStatus[model.id] = freshAgentStatus();

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no',
  });

  sseWrite(res, { type: 'meta', speaker: model.voiceName, modelName: model.modelName, speakerId: model.id, color: model.color });

  const fullText = await streamModelResponse(model, res);
  if (fullText === HUNG) return;
  if (fullText === null) { sseWrite(res, { type: 'error', message: `${model.voiceName} failed` }); res.end(); return; }

  if (generation !== myGen) { try { res.end(); } catch (e) {} return; }

  // v3: Process move through the grammar
  const moveResult = processMove(fullText, model.voiceName, model.id);
  let displayText = fullText;
  let muted = false;

  if (moveResult.error) {
    displayText = `[Parse error] ${moveResult.error} Raw: ${fullText.slice(0, 100)}`;
    console.log(`v3 parse error (${model.voiceName}): ${moveResult.error}`);
  } else {
    const parsed = moveResult.parsed;
    const muteResult = applyRepetitionMute(fullText, model.id, parsed.moveType);
    muted = muteResult.muted;
    displayText = muted ? muteResult.text : fullText;
    conversation.agentStatus[model.id] = conversation.agentStatus[model.id] || freshAgentStatus();

    if (conversation.cruxRoundActive && conversation.cruxAnswered) {
      conversation.cruxAttempts = (conversation.cruxAttempts || 0) + 1;
      if (!muted) { conversation.cruxAnswered.add(model.id); }
      if (conversation.cruxAnswered.size >= MODELS.length || conversation.cruxAttempts >= MODELS.length + 3) {
        conversation.cruxRoundActive = false;
      }
    }

    // Execute SEARCH / RUN moves
    let toolResult = null;
    if (parsed.moveType === 'SEARCH') toolResult = await executeSearch(parsed, model.voiceName, model.id);
    if (parsed.moveType === 'RUN') toolResult = await executeRun(parsed, model.voiceName, model.id);
    if (toolResult) {
      const resultSummary = toolResult.type === 'search_result'
        ? `Search results for "${toolResult.query}": ${toolResult.results?.map((r,i) => `[${i+1}] ${r.snippet.slice(0,120)} ${r.url}`).join(' | ') || 'none'}`
        : `RUN ${toolResult.runId} (${toolResult.intent}): ${toolResult.error ? 'ERROR: ' + toolResult.error : toolResult.output?.slice(0, 300)}`;
      conversation.messages.push({ speaker: 'System', model: null, content: resultSummary });
      if (toolResult.type === 'search_result') {
        const eid = nextEvidenceId();
        conversation.evidenceLedger = conversation.evidenceLedger || [];
        conversation.evidenceLedger.push({ id: eid, claim: toolResult.claimId, dir: 'supports', src: toolResult.results?.[0]?.url || '', summary: toolResult.results?.[0]?.snippet?.slice(0, 80) || '', attested_by: model.voiceName, verified_by: [] });
      }
      if (toolResult.type === 'run_result' && !toolResult.error) {
        const eid = nextEvidenceId();
        conversation.evidenceLedger = conversation.evidenceLedger || [];
        conversation.evidenceLedger.push({ id: eid, claim: toolResult.claimId, dir: 'supports', src: toolResult.runId, summary: (toolResult.output || '').slice(0, 80), attested_by: model.voiceName, verified_by: [] });
      }
      sseWrite(res, { type: 'tool_result', tool: toolResult });
      displayText += '\n[Tool result posted to shared state]';
    }
  }

  checkBoardEvents();
  conversation.messages.push({ speaker: model.voiceName, model: model.modelName, content: displayText });
  conversation.turnCount++;
  conversation.currentSpeaker = null;
  conversation.lastSpeakers.unshift(model.id);
  conversation.lastSpeakers = conversation.lastSpeakers.slice(0, 3);

  updateRollingSummary();

  const isToolMove = moveResult?.parsed && ['SEARCH', 'RUN'].includes(moveResult.parsed.moveType);
  const audio = (muted || isToolMove) ? null : await generateSpeech(fullText, model.voice);
  if (generation !== myGen) { try { res.end(); } catch (e) {} return; }

  const didInviteKyle = !conversation.indefinite && conversation.turnCount >= 3 && conversation.turnCount % 5 === 0;
  sseWrite(res, { type: 'done', audio, speaker: model.voiceName, speakerId: model.id, invitedKyle: didInviteKyle, muted });
  res.end();
});

// Set indefinite mode
app.post('/api/conversation/indefinite', (req, res) => {
  if (conversation) { conversation.indefinite = true; conversation.halt = false; }
  res.json({ ok: true });
});

// Crux round — manual trigger
app.post('/api/crux', (req, res) => {
  if (!conversation || !conversation.active) return res.status(400).json({ error: 'No active conversation' });
  conversation.cruxRoundActive = true;
  conversation.cruxAnswered = new Set();
  console.log('R3: Crux round triggered manually');
  res.json({ ok: true, message: 'Crux round started' });
});

// Crux ledger — view current and past crux rounds
app.get('/api/crux/ledger', (req, res) => {
  res.json({
    cruxLedger: conversation?.cruxLedger || [],
    cruxRoundActive: conversation?.cruxRoundActive || false,
    cruxAnsweredCount: conversation?.cruxAnswered?.size || 0,
    nextCruxRoundAt: conversation?.nextCruxRoundAt || 20,
    stagnationCounter: conversation?.stagnationCounter || 0,
  });
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
  conversation.turnCount = 0;
  const audio = await generateSpeech(response, model.voice);

  res.json({
    message: { speaker: model.voiceName, modelName: model.modelName, content: response, speakerId: model.id, color: model.color },
    audio, halted: true,
  });
});

app.post('/api/conversation/stop', async (req, res) => {
  if (!conversation) return res.json({ ok: true });
  // R6: Fire post-probes async before clearing active (don't block response)
  if (conversation.topic && conversation.active) {
    const topic = conversation.topic;
    const context = conversation.rollingSummary
      || (conversation.recentMoves || []).slice(-10).map(m => `${m.voiceName}: ${m.raw || m.body}`).join('\n');
    conversation.active = false;
    conversation.indefinite = false;
    res.json({ ok: true });
    // Run probes after responding so user isn't blocked
    runProbeRound(topic, null, 'post-private').catch(e => console.error('R6 post-private error:', e.message));
    runProbeRound(topic, context, 'post-informed').catch(e => console.error('R6 post-informed error:', e.message));
  } else {
    conversation.active = false;
    conversation.indefinite = false;
    res.json({ ok: true });
  }
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
    conversation.turnCount = conversation.messages.filter(m => m.speaker !== 'Kyle').length;
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

// ── R6: Pre/post belief probes ─────────────────────────────────────
const PROBE_SYSTEM = `You are being probed for your honest position on a topic. This is private — no other agent or human sees your answer. Respond in exactly this format:
POSITION: <one sentence stating your current position on the topic>
CONFIDENCE: <0-100, where 0=complete uncertainty, 100=certainty>`;

function probePrompt(topic, contextSummary) {
  if (contextSummary) {
    return `Topic: ${topic}\n\nContext (summary of the group discussion so far):\n${contextSummary}\n\nState your honest position and confidence.`;
  }
  return `Topic: ${topic}\n\nState your honest position and confidence. This is a pre-discussion probe — you have not yet discussed this topic with anyone.`;
}

async function probeOneModel(model, topic, contextSummary) {
  const userMsg = probePrompt(topic, contextSummary);
  try {
    let response = null;
    switch (model.id) {
      case 'chatgpt': response = await openAISync(openai, 'gpt-4o-mini', PROBE_SYSTEM, userMsg); break;
      case 'grok': response = await openAISync(grokClient, 'grok-3', PROBE_SYSTEM, userMsg); break;
      case 'deepseek': response = await openAISync(deepseekClient, 'deepseek-chat', PROBE_SYSTEM, userMsg); break;
      case 'claude': response = await claudeSync(PROBE_SYSTEM, userMsg); break;
      case 'gemini': response = await geminiSync(PROBE_SYSTEM, userMsg); break;
    }
    if (!response) return { voiceName: model.voiceName, modelId: model.id, error: 'No response' };
    const posMatch = response.match(/POSITION\s*:\s*(.+)/i);
    const confMatch = response.match(/CONFIDENCE\s*:\s*(\d+)/i);
    return {
      voiceName: model.voiceName, modelId: model.id,
      position: posMatch ? posMatch[1].trim() : response.slice(0, 200),
      confidence: confMatch ? parseInt(confMatch[1]) : null,
      raw: response,
    };
  } catch (err) {
    return { voiceName: model.voiceName, modelId: model.id, error: err.message };
  }
}

async function runProbeRound(topic, contextSummary, label) {
  console.log(`R6 probe [${label}]: querying ${MODELS.length} models on "${topic.slice(0, 60)}"`);
  const results = await Promise.all(MODELS.map(m => probeOneModel(m, topic, contextSummary)));
  const entry = { label, topic, contextSummary: !!contextSummary, timestamp: new Date().toISOString(), results };
  conversation.probeRounds = conversation.probeRounds || [];
  conversation.probeRounds.push(entry);
  console.log(`R6 probe [${label}] complete: ${results.filter(r => !r.error).length}/${MODELS.length} responded`);
  return entry;
}

function computeProbeReport() {
  const rounds = conversation?.probeRounds || [];
  if (rounds.length < 2) return { error: 'Need at least 2 probe rounds for a report', rounds: rounds.length };

  const pre = rounds[0]; // pre-discussion
  const postPrivate = rounds.find(r => r.label === 'post-private' && !r.contextSummary);
  const postInformed = rounds.find(r => r.label === 'post-informed' && r.contextSummary);

  if (!pre || (!postPrivate && !postInformed)) {
    return { error: 'Need pre and at least one post probe round', pre: !!pre, postPrivate: !!postPrivate, postInformed: !!postInformed };
  }

  const agents = [];
  for (const preResult of pre.results) {
    if (preResult.error) continue;
    const agent = { voiceName: preResult.voiceName, modelId: preResult.modelId };
    agent.prePosition = preResult.position;
    agent.preConfidence = preResult.confidence;

    // Post-private
    const postPriv = postPrivate?.results?.find(r => r.modelId === preResult.modelId);
    if (postPriv && !postPriv.error) {
      agent.postPrivatePosition = postPriv.position;
      agent.postPrivateConfidence = postPriv.confidence;
      agent.genuinePersuasionConfDelta = (postPriv.confidence || 0) - (preResult.confidence || 0);
    }

    // Post-informed (with transcript context)
    const postInf = postInformed?.results?.find(r => r.modelId === preResult.modelId);
    if (postInf && !postInf.error) {
      agent.postInformedPosition = postInf.position;
      agent.postInformedConfidence = postInf.confidence;
      if (agent.postPrivateConfidence !== undefined) {
        agent.socialComplianceGap = (postInf.confidence || 0) - (agent.postPrivateConfidence || 0);
      }
    }

    agents.push(agent);
  }

  return { rounds: rounds.length, agents };
}

// ── R6 API routes ──────────────────────────────────────────────────
app.post('/api/probes/pre', async (req, res) => {
  if (!conversation || !conversation.active) return res.status(400).json({ error: 'No active conversation' });
  const topic = conversation.topic || req.body.topic;
  if (!topic) return res.status(400).json({ error: 'No topic set' });
  const entry = await runProbeRound(topic, null, 'pre');
  res.json({ ok: true, label: 'pre', count: entry.results.length });
});

app.post('/api/probes/post', async (req, res) => {
  if (!conversation || !conversation.active) return res.status(400).json({ error: 'No active conversation' });
  const topic = conversation.topic;
  if (!topic) return res.status(400).json({ error: 'No topic set' });

  // Post-private: topic only, no context
  const privateEntry = await runProbeRound(topic, null, 'post-private');
  // Post-informed: topic + rolling summary (or recent moves if no summary)
  const context = conversation.rollingSummary
    || (conversation.recentMoves || []).slice(-10).map(m => `${m.voiceName}: ${m.raw || m.body}`).join('\n');
  const informedEntry = await runProbeRound(topic, context, 'post-informed');

  res.json({
    ok: true,
    privateCount: privateEntry.results.length,
    informedCount: informedEntry.results.length,
  });
});

app.get('/api/probes/report', (req, res) => {
  const report = computeProbeReport();
  res.json(report);
});

// ── Start server ───────────────────────────────────────────────────
const PORT = process.env.PORT || 3009;
resetConversation();

app.listen(PORT, () => {
  console.log(`\n  AI Group Chat running at http://localhost:${PORT}\n`);
  if (MODELS.length > 0) {
    console.log(`  Active models: ${MODELS.map(m => `${m.voiceName} (${m.modelName})`).join(', ')}\n`);
  }
});
