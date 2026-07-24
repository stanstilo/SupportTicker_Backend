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
import threading
from collections import OrderedDict
from typing import Optional

from fastapi import FastAPI
from pydantic import BaseModel, Field

import engine
from engine import Engine
import stt as stt_engine
import translate as translate_engine
import mms_tts

logging.basicConfig(level=os.getenv("TTS_LOG_LEVEL", "INFO"))
log = logging.getLogger("tts.app")

# Warm the Whisper model on boot unless disabled (first request otherwise pays
# the model-load/download cost).
WHISPER_PRELOAD = os.getenv("WHISPER_PRELOAD", "true").lower() not in ("0", "false", "no")
# Warm the neural MMS-TTS models on boot (in a background thread, so boot stays
# instant). On by default: without it the FIRST native request pays a cold model
# load (Yorùbá ~35s on CPU) that exceeds the Node proxy timeout, so the client
# falls back to the English browser voice. Set MMS_PRELOAD=off to disable (e.g.
# very memory-constrained hosts). No-op where MMS isn't installed.
MMS_PRELOAD = os.getenv("MMS_PRELOAD", "true").lower() not in ("0", "false", "no")

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


class TranscribeIn(BaseModel):
    # Base64 (or a data: URL) of a recorded audio clip.
    audioBase64: str = Field(default="")
    mime: Optional[str] = None
    language: Optional[str] = None
    partial: Optional[bool] = False  # interim streaming result (ungated)


class TranslateIn(BaseModel):
    text: str = Field(default="", max_length=8000)
    source: Optional[str] = None  # 'auto' | 'en' | 'ig' | 'yo' | 'ha'
    target: Optional[str] = None


@app.on_event("startup")
def _startup() -> None:
    eng = get_engine()
    binary = engine.espeak_bin()
    log.info("espeak-ng: %s | phonemizer: %s | mp3: %s | lexicons: %s",
             binary or "MISSING",
             "yes" if engine._phonemizer_available() else "no",
             PREFER_MP3,
             {l: eng.lexicon.size(l) for l in eng.lexicon.languages()})
    log.info("STT (faster-whisper) available: %s | model: %s",
             stt_engine.stt_available(), stt_engine.WHISPER_MODEL)
    if WHISPER_PRELOAD and stt_engine.stt_available():
        stt_engine.preload()
    log.info("MMS-TTS (neural native voices) available: %s | languages: %s",
             mms_tts.mms_available(), mms_tts.supported_languages())
    if MMS_PRELOAD and mms_tts.mms_available():
        # Warm the neural voices off the boot thread so the service is ready
        # immediately AND the first native request doesn't pay a cold model load
        # (Yorùbá ~35s) — which would exceed the Node proxy timeout and make the
        # client fall back to the English browser voice.
        threading.Thread(target=mms_tts.preload, name="mms-preload", daemon=True).start()


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
        "stt": stt_engine.stt_available(),
        "sttModel": stt_engine.WHISPER_MODEL,
        "translate": translate_engine.translate_available(),
        "mms": mms_tts.mms_available(),
        "mmsLangs": mms_tts.supported_languages(),
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

    # Prefer the neural native voice (MMS-TTS) for supported languages; fall
    # back to the espeak engine when MMS is unavailable or can't synthesize.
    result = mms_tts.synthesize(text, lang) if mms_tts.supports(lang) else None
    if not (result and result.get("audioBase64")):
        result = get_engine().synthesize(text, lang).to_dict()

    # Only cache successful audio; fallbacks are cheap to recompute and may
    # change once a voice/lexicon is installed.
    if result.get("audioBase64"):
        _cache[key] = result
        while len(_cache) > MAX_CACHE:
            _cache.popitem(last=False)
    return result


@app.post("/transcribe")
def transcribe(body: TranscribeIn) -> dict:
    """Speech-to-text: base64 audio -> { text, language, fallback, warning }."""
    if not (body.audioBase64 or "").strip():
        return {"text": "", "language": (body.language or "en"), "fallback": True,
                "warning": "Audio is required."}
    return stt_engine.transcribe(body.audioBase64, body.mime or "", body.language, bool(body.partial))


@app.post("/translate")
def translate(body: TranslateIn) -> dict:
    """Translate text between the app languages -> { text, translated, source, target }."""
    return translate_engine.translate(body.text or "", body.source or "auto", body.target or "en")
