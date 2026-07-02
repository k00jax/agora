"""Agora TTS Microservice — wraps Microsoft Edge TTS via edge-tts"""

import asyncio
import io
import time
import re

asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel
from edge_tts import Communicate

app = FastAPI(title="Agora TTS", version="1.0.0")

VOICES = {
    "Natasha": "en-AU-NatashaNeural",
    "Andrew": "en-US-AndrewNeural",
    "Libby": "en-GB-LibbyNeural",
    "Christopher": "en-US-ChristopherNeural",
    "William": "en-AU-WilliamNeural",
}

# Simple in-memory cache: (text, voice) -> mp3 bytes
CACHE: dict[tuple[str, str], bytes] = {}
CACHE_MAX = 200

def strip_markdown(text: str) -> str:
    text = re.sub(r"\*\*(.+?)\*\*", r"\1", text)
    text = re.sub(r"\*(.+?)\*", r"\1", text)
    text = re.sub(r"`{1,3}[^`]*`{1,3}", "", text)
    text = re.sub(r"^#{1,6}\s+", "", text, flags=re.MULTILINE)
    text = re.sub(r"^[-*+]\s+", "", text, flags=re.MULTILINE)
    text = re.sub(r"^\d+\.\s+", "", text, flags=re.MULTILINE)
    text = re.sub(r"^>\s+", "", text, flags=re.MULTILINE)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


class TTSRequest(BaseModel):
    text: str
    voice: str  # voice name like "Andrew", "Natasha", etc.


@app.get("/health")
async def health():
    return {"status": "ok", "cached": len(CACHE)}


@app.post("/tts")
async def tts(req: TTSRequest):
    voice_id = VOICES.get(req.voice)
    if not voice_id:
        raise HTTPException(400, f"Unknown voice: {req.voice}")

    text = strip_markdown(req.text)
    if not text.strip():
        raise HTTPException(400, "Empty text after stripping markdown")

    cache_key = (text, voice_id)
    if cache_key in CACHE:
        return Response(content=CACHE[cache_key], media_type="audio/mpeg")

    mp3_buffer = io.BytesIO()
    try:
        communicate = Communicate(text, voice_id)
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                mp3_buffer.write(chunk["data"])
    except Exception as e:
        raise HTTPException(500, f"TTS generation failed: {e}")

    mp3_bytes = mp3_buffer.getvalue()
    if len(mp3_bytes) < 100:
        raise HTTPException(500, "TTS produced empty audio")

    # Cache it
    if len(CACHE) >= CACHE_MAX:
        # Evict oldest (simple FIFO)
        oldest = next(iter(CACHE))
        del CACHE[oldest]
    CACHE[cache_key] = mp3_bytes

    return Response(content=mp3_bytes, media_type="audio/mpeg")


@app.post("/tts/batch")
async def tts_batch(reqs: list[TTSRequest]):
    """Batch TTS — returns array of base64-encoded MP3s"""
    results = []
    for r in reqs:
        voice_id = VOICES.get(r.voice)
        if not voice_id:
            results.append({"error": f"Unknown voice: {r.voice}"})
            continue

        text = strip_markdown(r.text)
        if not text.strip():
            results.append({"error": "Empty text"})
            continue

        cache_key = (text, voice_id)
        if cache_key in CACHE:
            import base64
            results.append({"audio": base64.b64encode(CACHE[cache_key]).decode()})
            continue

        mp3_buffer = io.BytesIO()
        try:
            communicate = Communicate(text, voice_id)
            async for chunk in communicate.stream():
                if chunk["type"] == "audio":
                    mp3_buffer.write(chunk["data"])
            mp3_bytes = mp3_buffer.getvalue()
            if len(mp3_bytes) < 100:
                results.append({"error": "Empty audio"})
                continue
            if len(CACHE) >= CACHE_MAX:
                oldest = next(iter(CACHE))
                del CACHE[oldest]
            CACHE[cache_key] = mp3_bytes
            import base64
            results.append({"audio": base64.b64encode(mp3_bytes).decode()})
        except Exception as e:
            results.append({"error": str(e)})

    return {"results": results}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8080)
