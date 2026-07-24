"""
Self-hosted speech-to-text using faster-whisper (CTranslate2 Whisper).

Runs entirely in this process — no OpenAI billing and no dependency on Google's
speech servers (which corporate networks often block). The Node backend proxies
recorded audio here via POST /transcribe.

Model + runtime are configurable by env:
  WHISPER_MODEL        tiny | base | small | medium  (default: base)
  WHISPER_DEVICE       cpu | cuda                     (default: cpu)
  WHISPER_COMPUTE_TYPE int8 | int8_float16 | float16  (default: int8)

The model is loaded lazily on first request and kept warm. Audio is decoded by
faster-whisper via PyAV (bundled ffmpeg), so webm/opus, mp4, ogg and wav all
work without a system ffmpeg install.
"""

from __future__ import annotations

import base64
import logging
import os
import tempfile
from typing import Optional

log = logging.getLogger("tts.stt")

# 'base' is the interactive-chat sweet spot on CPU: fast, small download, and
# accurate on clean audio. Bump to 'small'/'medium' for more accuracy on hard
# audio (slower), or 'tiny' for the lowest latency.
WHISPER_MODEL = os.getenv("WHISPER_MODEL", "base")
# A smaller/faster model for live interim (partial) transcription — it's only a
# preview, so speed matters more than accuracy; the final pass uses WHISPER_MODEL.
WHISPER_PARTIAL_MODEL = os.getenv("WHISPER_PARTIAL_MODEL", "tiny")
WHISPER_DEVICE = os.getenv("WHISPER_DEVICE", "cpu")
WHISPER_COMPUTE_TYPE = os.getenv("WHISPER_COMPUTE_TYPE", "int8")
# Beam size: 1 (greedy) is fastest; higher is more accurate but slower. VAD
# trims silence (fewer dropped words/hallucinations + less audio to decode).
WHISPER_BEAM_SIZE = int(os.getenv("WHISPER_BEAM_SIZE", "1"))
WHISPER_VAD = os.getenv("WHISPER_VAD", "true").lower() not in ("0", "false", "no")
# CPU inference threads for ctranslate2. 0 = auto-detect; set to your physical
# core count if inference is slow (over-subscribing logical cores can hurt).
WHISPER_CPU_THREADS = int(os.getenv("WHISPER_CPU_THREADS", "0"))

# Whisper language hints (ISO-639-1). Igbo ('ig') isn't in Whisper's set, so we
# omit the hint and let it auto-detect rather than pass an unsupported code.
_WHISPER_LANGS = {"en": "en", "yo": "yo", "ha": "ha"}

# Domain vocabulary primes the decoder for the bank's common terms so they're
# not misheard. Whisper is weak on Yorùbá/Hausa and mishears domain words
# (e.g. "àkàǹtì"/account → "akule"), which then translate to nonsense and miss
# the knowledge base — so each language gets a prompt IN ITS OWN SCRIPT to bias
# the decoder toward the right banking words. Terms reuse the app's vetted locale
# strings (see LOCALES in src/routes/assistant.ts). Final pass only (partials
# skip the prompt to avoid hallucination on short clips).
_DOMAIN_PROMPT = (
    "Support assistant for a Nigerian bank. Common terms: account, savings account, "
    "current account, BVN, NIN, password, transfer, debit card, statement, branch, "
    "mobile app, support ticket, escalation, Stanbic IBTC."
)
_DOMAIN_PROMPTS = {
    "en": _DOMAIN_PROMPT,
    "yo": (
        "Ìbéèrè àtìlẹ́yìn fún báǹkì. Àwọn ọ̀rọ̀: àkántì, àkántì ìfowópamọ́, akẹ́kọ̀ọ́, "
        "ọ̀rọ̀ ìwọlé, gbígbé owó, káàdì, tíkẹ́ẹ̀tì, Stanbic IBTC."
    ),
    "ha": (
        "Tambayar tallafi don banki. Kalmomi: asusu, asusun ajiya, ɗalibi, "
        "kalmar sirri, tura kuɗi, kati, tikiti, Stanbic IBTC."
    ),
}

_models: dict = {}       # model name -> WhisperModel
_load_errors: dict = {}  # model name -> error string


def stt_available() -> bool:
    """True when faster-whisper is importable (model may still load lazily)."""
    try:
        import faster_whisper  # noqa: F401
        return True
    except Exception:
        return False


def _suffix_for(mime: str) -> str:
    m = (mime or "").lower()
    if "mp4" in m or "m4a" in m:
        return ".mp4"
    if "mpeg" in m or "mp3" in m:
        return ".mp3"
    if "wav" in m:
        return ".wav"
    if "ogg" in m:
        return ".ogg"
    return ".webm"


def _get_model(name: str = ""):
    """Load (and cache) a Whisper model by name. Raises RuntimeError on failure."""
    name = name or WHISPER_MODEL
    if name in _models:
        return _models[name]
    if name in _load_errors:
        raise RuntimeError(_load_errors[name])
    try:
        from faster_whisper import WhisperModel
        log.info(
            "Loading Whisper model '%s' (%s/%s, cpu_threads=%s)…",
            name, WHISPER_DEVICE, WHISPER_COMPUTE_TYPE, WHISPER_CPU_THREADS or "auto",
        )
        _models[name] = WhisperModel(
            name,
            device=WHISPER_DEVICE,
            compute_type=WHISPER_COMPUTE_TYPE,
            cpu_threads=WHISPER_CPU_THREADS,  # 0 = ctranslate2 auto
        )
        log.info("Whisper model '%s' loaded.", name)
        return _models[name]
    except Exception as e:  # missing dep or model download failure
        _load_errors[name] = f"Whisper model '{name}' unavailable: {e}"
        log.warning(_load_errors[name])
        raise RuntimeError(_load_errors[name])


def preload() -> None:
    """Best-effort warm-up so the first real request isn't slow. Never raises."""
    for name in {WHISPER_MODEL, WHISPER_PARTIAL_MODEL}:
        try:
            _get_model(name)
        except Exception:
            pass


# Below this mean segment log-probability the transcription is treated as an
# unreliable guess (likely a hallucination on unclear/quiet audio) and rejected.
WHISPER_MIN_LOGPROB = float(os.getenv("WHISPER_MIN_LOGPROB", "-1.0"))
# Reject clips with almost no speech after VAD (nothing real was said).
WHISPER_MIN_SPEECH_SEC = float(os.getenv("WHISPER_MIN_SPEECH_SEC", "0.4"))


def _fallback(lang: str, warning: str, retryable: bool = False) -> dict:
    # retryable=True → transcription ran but was unclear/too short: the user
    # should just speak again (don't switch engines). retryable=False → the
    # engine itself couldn't run (model load / decode error).
    return {"text": "", "language": lang, "fallback": True, "warning": warning, "retryable": retryable}


def transcribe(audio_base64: str, mime: str, language: Optional[str], partial: bool = False) -> dict:
    """Transcribe a base64 audio clip. Never raises — returns a fallback dict.

    `partial=True` is for live/interim streaming: it returns whatever text was
    decoded WITHOUT the confidence/duration gating, so words show as the user
    speaks (the final, non-partial pass applies the gating).
    """
    lang = (language or "en").lower()

    # Whisper has no Igbo model — it only ever hallucinates on Igbo audio, which
    # the confidence gate then rejects in a confusing loop. Say so clearly
    # instead of emitting/looping a guess. (yo/ha ARE supported.)
    if lang not in _WHISPER_LANGS and lang != "en":
        return {"text": "", "language": lang, "fallback": True, "retryable": False,
                "unsupported": True,
                "warning": f"Speech-to-text isn't available for '{lang}' yet."}

    raw = audio_base64 or ""
    if raw.startswith("data:"):
        raw = raw.split(",", 1)[-1]
    raw = raw.strip()
    if not raw:
        return _fallback(lang, "Empty audio.")

    try:
        data = base64.b64decode(raw, validate=False)
    except Exception:
        return _fallback(lang, "Invalid audio encoding.")
    if not data:
        return _fallback(lang, "Empty audio.")

    try:
        # Live partials use the fast model; the final pass uses the accurate one.
        model = _get_model(WHISPER_PARTIAL_MODEL if partial else WHISPER_MODEL)
    except Exception as e:
        return _fallback(lang, str(e))

    hint = _WHISPER_LANGS.get(lang)
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=_suffix_for(mime), delete=False) as f:
            f.write(data)
            tmp_path = f.name
        # Prime the decoder with domain vocabulary in the request language — but
        # ONLY on the final pass. On short partial clips (the first 1–3s of live
        # streaming) a strong initial_prompt makes Whisper echo/hallucinate the
        # prompt's words instead of what was actually said, so the live text
        # writes wrong words. Partials therefore get no prompt; the accurate
        # final pass uses the native-language prompt to catch banking terms.
        prompt = None if partial else _DOMAIN_PROMPTS.get(lang)
        segments, info = model.transcribe(
            tmp_path,
            language=hint,
            beam_size=WHISPER_BEAM_SIZE,
            vad_filter=WHISPER_VAD,
            # Short one-off clips: don't carry context between them (prevents
            # drift/repetition). Keep Whisper's default temperature schedule so
            # its built-in compression/log-prob fallback re-decodes suspicious
            # output.
            condition_on_previous_text=False,
            initial_prompt=prompt,
        )
        segs = list(segments)
        text = "".join(seg.text for seg in segs).strip()
        detected = getattr(info, "language", None) or lang

        # Interim streaming result: show whatever we have, ungated, so words
        # appear as the user speaks. Empty is fine (still recording).
        if partial:
            return {"text": text, "language": detected, "fallback": not text,
                    "warning": None, "partial": True, "retryable": True}

        # Confidence + speech-duration signals to reject hallucinated guesses on
        # unclear/quiet audio (the "I asked X, it heard something else" case).
        avg_logprob = sum(s.avg_logprob for s in segs) / len(segs) if segs else -5.0
        speech_sec = float(getattr(info, "duration_after_vad", getattr(info, "duration", 0.0)) or 0.0)
        log.info(
            "STT model=%s lang=%s speech=%.2fs avg_logprob=%.2f text=%r",
            WHISPER_MODEL, detected, speech_sec, avg_logprob, text[:100],
        )

        if not text or speech_sec < WHISPER_MIN_SPEECH_SEC:
            return _fallback(detected, "No clear speech detected — please try again.", retryable=True)
        if avg_logprob < WHISPER_MIN_LOGPROB:
            return _fallback(
                detected,
                f"Low-confidence transcription (avg_logprob {avg_logprob:.2f}) — please try again.",
                retryable=True,
            )
        return {"text": text, "language": detected, "fallback": False, "warning": None,
                "confidence": round(avg_logprob, 2)}
    except Exception as e:
        log.warning("Whisper transcription failed: %s", e)
        return _fallback(lang, f"Transcription failed: {e}")
    finally:
        if tmp_path:
            try:
                os.remove(tmp_path)
            except OSError:
                pass
