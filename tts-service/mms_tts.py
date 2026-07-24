"""
Neural text-to-speech for native languages via Meta's MMS-TTS (VITS) models:
Igbo, Yorùbá, Hausa. These are genuine native voices — far better than the
espeak/browser fallback — and run locally with no API key.

Heavy deps (torch + transformers) are intentionally NOT in the base
requirements so the free-tier deploy stays small. Install them to enable:

    pip install -r requirements-mms.txt

When they're absent (or MMS_TTS=off), `mms_available()` is False and the caller
falls back to the espeak engine. Models are ~145MB each, loaded lazily on first
use per language and cached warm.

Env:
    MMS_TTS         auto (default) | off
    MMS_MAX_CHARS   cap per utterance (default 600)
"""

from __future__ import annotations

import base64
import io
import logging
import os
import unicodedata
import wave
from typing import Optional

log = logging.getLogger("tts.mms")

# App language code -> HF model (all VITS, loadable via VitsModel).
# Yorùbá/Hausa use Meta's public MMS-TTS. Meta GATED the Igbo one
# (facebook/mms-tts-ibo → 401), so the default is a public MMS Igbo mirror;
# override any with MMS_MODEL_IG / _YO / _HA (e.g. point IG at facebook's after
# accepting its terms and setting HF_TOKEN).
_MODELS = {
    "ig": os.getenv("MMS_MODEL_IG", "rnjema-unima/mms-tts-ibo-baseline"),
    "yo": os.getenv("MMS_MODEL_YO", "facebook/mms-tts-yor"),
    "ha": os.getenv("MMS_MODEL_HA", "facebook/mms-tts-hau"),
}

# Optional HF token — needed only for gated models (e.g. facebook/mms-tts-ibo).
_HF_TOKEN = os.getenv("HF_TOKEN") or os.getenv("HUGGING_FACE_HUB_TOKEN") or None

MMS_MODE = os.getenv("MMS_TTS", "auto").strip().lower()  # auto | off
MMS_MAX_CHARS = int(os.getenv("MMS_MAX_CHARS", "600"))

_models: dict = {}        # lang -> (model, tokenizer)
_load_errors: dict = {}   # lang -> error string
_vocabs: dict = {}        # lang -> frozenset of tokenizer vocab tokens


def _vocab_for(lang: str, tokenizer) -> frozenset:
    """Cache the (small) per-language VITS vocab as a set for fast membership."""
    if lang not in _vocabs:
        _vocabs[lang] = frozenset(tokenizer.get_vocab().keys())
    return _vocabs[lang]


def _map_to_vocab(text: str, vocab: frozenset) -> str:
    """Map characters the model's vocab lacks onto their closest in-vocab base so
    essential letters aren't silently dropped.

    MMS VITS tokenizers have a tiny per-language character vocab and DROP any
    character not in it. Some models are missing letters that the language
    actually uses — e.g. this Igbo model has ọ/ẹ/ṣ but NOT the dotted vowels
    ị/ụ or ṅ, so "gị" ("you") loses its vowel and is spoken as just "g", and
    "ụlọ" ("house") loses the leading ụ. That is the "wrong pronunciation /
    swallowed letters" symptom.

    Strategy (a strict improvement — in-vocab text is returned unchanged):
      * lowercase (VITS normalizes to lowercase anyway),
      * keep spaces and characters already in the vocab as-is,
      * otherwise NFD-decompose and keep the base letter (plus any combining
        marks the vocab does know, e.g. tone accents), dropping only the
        unsupported diacritic. So ị→i, ụ→u, ṅ→n instead of vanishing, while
        supported precomposed letters (ọ/ẹ/ṣ and Yorùbá tone vowels) are kept.
    """
    out = []
    for ch in text.lower():
        if ch == " " or ch in vocab:
            out.append(ch)
            continue
        decomp = unicodedata.normalize("NFD", ch)
        base = "".join(c for c in decomp if not unicodedata.combining(c))
        marks = "".join(c for c in decomp if unicodedata.combining(c) and c in vocab)
        out.append("".join(c for c in (base + marks) if c in vocab))
    return "".join(out)


def mms_available() -> bool:
    """True when torch + transformers are importable and MMS isn't disabled."""
    if MMS_MODE == "off":
        return False
    try:
        import torch  # noqa: F401
        import transformers  # noqa: F401
        return True
    except Exception:
        return False


def supported_languages() -> list:
    return list(_MODELS.keys()) if mms_available() else []


def supports(lang: str) -> bool:
    return lang in _MODELS and mms_available()


def _get(lang: str):
    """Load (and cache) the VITS model + tokenizer for a language."""
    if lang in _models:
        return _models[lang]
    if lang in _load_errors:
        raise RuntimeError(_load_errors[lang])
    try:
        from transformers import AutoTokenizer, VitsModel
        name = _MODELS[lang]
        log.info("Loading MMS-TTS %s (%s)…", lang, name)
        model = VitsModel.from_pretrained(name, token=_HF_TOKEN)
        tokenizer = AutoTokenizer.from_pretrained(name, token=_HF_TOKEN)
        model.eval()
        _models[lang] = (model, tokenizer)
        log.info("MMS-TTS %s loaded.", lang)
        return _models[lang]
    except Exception as e:
        _load_errors[lang] = f"MMS-TTS {lang} load failed: {e}"
        log.warning(_load_errors[lang])
        raise RuntimeError(_load_errors[lang])


def preload() -> None:
    """Best-effort warm-up of all native-language models. Never raises."""
    if not mms_available():
        return
    for lang in _MODELS:
        try:
            _get(lang)
        except Exception:
            pass


def synthesize(text: str, lang: str) -> Optional[dict]:
    """
    Synthesize `text` in `lang` with MMS-TTS. Returns a TtsResult-shaped dict
    (WAV, base64) or None when MMS can't handle it (unsupported lang, deps
    missing, or an error) so the caller falls back to espeak.
    """
    if not supports(lang):
        return None
    text = (text or "").strip()[:MMS_MAX_CHARS]
    if not text:
        return None

    try:
        import numpy as np
        import torch

        model, tokenizer = _get(lang)
        # Remap characters the model's vocab lacks (e.g. Igbo ị/ụ/ṅ) so they
        # aren't silently dropped and mispronounced. In-vocab text is unchanged.
        prepared = _map_to_vocab(text, _vocab_for(lang, tokenizer))
        if not prepared.strip():
            prepared = text  # nothing survived the map — let the tokenizer decide
        if prepared != text.lower():
            log.info("MMS-TTS %s remapped text for vocab: %r -> %r", lang, text, prepared)
        inputs = tokenizer(prepared, return_tensors="pt")
        with torch.no_grad():
            waveform = model(**inputs).waveform  # [1, samples] float32 in [-1, 1]

        arr = waveform.squeeze(0).cpu().numpy()
        sample_rate = int(model.config.sampling_rate)
        pcm16 = (np.clip(arr, -1.0, 1.0) * 32767.0).astype("<i2")

        buf = io.BytesIO()
        with wave.open(buf, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(sample_rate)
            w.writeframes(pcm16.tobytes())

        return {
            "audioBase64": base64.b64encode(buf.getvalue()).decode("ascii"),
            "mime": "audio/wav",
            "fallback": False,
            "approx": False,  # a genuine native voice, not an approximation
            "warning": None,
            "voice": f"mms-{lang}",
            "language": lang,
            "ipa": None,
        }
    except Exception as e:
        log.warning("MMS-TTS synth failed (%s): %s", lang, e)
        return None
