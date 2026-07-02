# Agora

Five AI voices. One roundtable. Real debate.

Agora brings five AI models — **Natasha** (Grok), **Andrew** (DeepSeek), **Libby** (Gemini), **Christopher** (Claude), and **William** (ChatGPT) — into a live voice-enabled group chat. Each speaks with a distinct voice. Each argues from its own perspective. You sit at the table with them.

Unlike chatbots that defer to you, these models talk to *each other*. They agree, disagree, form alliances, change their minds, and pull you in when your perspective matters. The experience is closer to listening to a panel discussion than using a tool.

## Features

- **5 AI voices** — edge-tts powered, each with a distinct accent and cadence (Australian, British, American)
- **Real-time streaming** — responses appear word-by-word as they're generated, with speech bubbles above each avatar
- **Weighted speaker selection** — no one dominates; models who've been quiet get priority to keep the conversation balanced
- **Anti-ping-pong logic** — detects when two models are looping and breaks the pattern automatically
- **Name-aware addressing** — say "Andrew, what do you think?" and Andrew responds next
- **Interrupt** — cut in mid-response; a different model acknowledges you and the floor is yours
- **Continue Indefinitely** — let the AIs debate endlessly among themselves while you listen (warning: consumes API tokens)
- **Voice input** — press-and-hold to speak via browser-native speech recognition
- **Chat persistence** — sidebar with saved conversations, load and replay past discussions
- **Identical system prompt** — every model operates under the same instructions. Differences emerge naturally from the weights, not from engineered personas.

## Quick Start

### Prerequisites

- Node.js 22+
- Python 3.10+ with `edge-tts` installed:
  ```bash
  pip install edge-tts
  ```
- API keys for the models you want to enable (any subset works — one model alone is enough)

### Setup

```bash
git clone https://github.com/k00jax/ai-group-chat.git
cd ai-group-chat
npm install
cp .env.example .env
```

Edit `.env` and add your API keys:

```env
OPENAI_API_KEY=sk-...        # ChatGPT (William)
ANTHROPIC_API_KEY=sk-ant-... # Claude (Christopher)
GEMINI_API_KEY=...           # Gemini (Libby)
GROK_API_KEY=...             # Grok (Natasha)
DEEPSEEK_API_KEY=...         # DeepSeek (Andrew)
```

Only the keys you provide will activate those models. The app works with just one, but is designed for all five.

### Run

```bash
npm start
```

Open **http://localhost:3009**. Press and hold the button, say something like "Let's debate whether AI should be regulated," and the models will begin.

## Architecture

```
agora/
  server.js          Express server, SSE streaming, API routing, TTS
  public/index.html  Complete browser client (vanilla JS, no build step)
  tts.py             edge-tts wrapper (Microsoft Edge TTS voices)
  chats/             Saved conversation history (JSON)
  saas/              WIP: multi-user SaaS version (Next.js + Supabase + Stripe)
```

The app is **two files** at its core — `server.js` (the backend) and `public/index.html` (the entire frontend). No framework, no build step, no database. The SaaS branch adds all of that.

## Voice Map

| Name | Model | Voice | Accent |
|------|-------|-------|--------|
| Natasha | Grok | en-AU-NatashaNeural | Australian female |
| Andrew | DeepSeek | en-US-AndrewNeural | American male |
| Libby | Gemini | en-GB-LibbyNeural | British female |
| Christopher | Claude | en-US-ChristopherNeural | American male |
| William | ChatGPT | en-AU-WilliamNeural | Australian male |

## How It Works

1. You speak or type a message
2. The server picks the next AI speaker using weighted random selection (models who've been quiet get higher probability; the last speaker is excluded)
3. The selected model receives the full conversation transcript plus the identical shared system prompt
4. The response streams back via SSE — tokens appear in a speech bubble above the speaking avatar in real-time
5. The model's response is spoken aloud via edge-tts in its assigned voice
6. After audio finishes, the next model is selected and responds
7. Every ~5 AI turns, the models naturally invite you back in
8. At any point, you can interrupt, respond, or click "Continue Indefinitely" to let them talk without you

## Branches

- **`main`** — the working localhost app (this branch). Single-user, no auth, no database.
- **`saas-commercial`** — work-in-progress multi-user SaaS with OAuth, Stripe payments, per-user API keys, and PostgreSQL persistence.

## License

MIT
