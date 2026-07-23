"""
FastAPI TTS service — the real speech engine behind the Node backend.

Node (Fastify) is a thin façade: it authenticates, validates, and proxies to
`POST /synthesize` here. This process owns espeak-ng, phonemizer, and the IPA
lexicon, and keeps them warm across requests.

Endpoints:
  GET  /health       -> readiness + engine capability report
  POST /synthesize   -> { text, language } -> TtsResult (see engine.TtsResult)

Run:
  uvicorn app:app --host 0.0.0.0 --port 8081
"""

from __future__ import annotations

import hashlib
import logging
import os
from collections import OrderedDict
from typing import Optional

from fastapi import FastAPI
from pydantic import BaseModel, Field

import engine
from engine import Engine

logging.basicConfig(level=os.getenv("TTS_LOG_LEVEL", "INFO"))
log = logging.getLogger("tts.app")

PREFER_MP3 = os.getenv("TTS_AUDIO_FORMAT", "wav").lower() == "mp3"
MAX_CACHE = int(os.getenv("TTS_CACHE_SIZE", "200"))

app = FastAPI(title="Support Ticker TTS", version="1.0.0")
_engine: Optional[Engine] = None

# lang|text sha256 -> serialized TtsResult dict. OrderedDict = cheap LRU.
_cache: "OrderedDict[str, dict]" = OrderedDict()


def get_engine() -> Engine:
    global _engine
    if _engine is None:
        _engine = Engine(prefer_mp3=PREFER_MP3)
    return _engine


class SynthesizeIn(BaseModel):
    text: str = Field(default="", max_length=4000)
    language: Optional[str] = None


@app.on_event("startup")
def _startup() -> None:
    eng = get_engine()
    binary = engine.espeak_bin()
    log.info("espeak-ng: %s | phonemizer: %s | mp3: %s | lexicons: %s",
             binary or "MISSING",
             "yes" if engine._phonemizer_available() else "no",
             PREFER_MP3,
             {l: eng.lexicon.size(l) for l in eng.lexicon.languages()})


@app.get("/health")
def health() -> dict:
    eng = get_engine()
    return {
        "ok": engine.espeak_bin() is not None,
        "espeak": engine.espeak_bin(),
        "phonemizer": engine._phonemizer_available(),
        "mp3": PREFER_MP3,
        "voices": sorted(set(engine._voice_index().values())),
        "lexicons": {l: eng.lexicon.size(l) for l in eng.lexicon.languages()},
    }


def _cache_key(lang: str, text: str) -> str:
    return hashlib.sha256(f"{lang}|{text}".encode("utf-8")).hexdigest()


@app.post("/synthesize")
def synthesize(body: SynthesizeIn) -> dict:
    text = (body.text or "").strip()
    lang = (body.language or engine.DEFAULT_LANG).lower()
    if not text:
        return engine.TtsResult(fallback=True, warning="Empty text.",
                                language=lang).to_dict()

    key = _cache_key(lang, text[:engine.MAX_TEXT])
    if key in _cache:
        _cache.move_to_end(key)
        return _cache[key]

    result = get_engine().synthesize(text, lang).to_dict()

    # Only cache successful audio; fallbacks are cheap to recompute and may
    # change once a voice/lexicon is installed.
    if result.get("audioBase64"):
        _cache[key] = result
        while len(_cache) > MAX_CACHE:
            _cache.popitem(last=False)
    return result
