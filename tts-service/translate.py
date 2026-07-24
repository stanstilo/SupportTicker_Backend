"""
Text translation via deep_translator's GoogleTranslator (no API key).

Used so the assistant can accept questions in Igbo/Yorùbá/Hausa: the Node
backend translates the query to English, runs the English knowledge-base
retrieval, then translates the answer back to the user's selected language.

Never raises — on any failure (network blocked, unsupported pair) it returns the
original text with `translated: false` so the caller degrades gracefully.
"""

from __future__ import annotations

import logging
from typing import Optional

log = logging.getLogger("tts.translate")

# Google Translate language codes for the app's languages.
_SUPPORTED = {"en", "ig", "yo", "ha", "auto"}


def translate_available() -> bool:
    try:
        from deep_translator import GoogleTranslator  # noqa: F401
        return True
    except Exception:
        return False


def translate(text: str, source: Optional[str], target: Optional[str]) -> dict:
    text = (text or "").strip()
    src = (source or "auto").lower()
    tgt = (target or "en").lower()
    if not text:
        return {"text": "", "translated": False, "source": src, "target": tgt}
    if src == tgt:
        return {"text": text, "translated": False, "source": src, "target": tgt}

    try:
        from deep_translator import GoogleTranslator
        # GoogleTranslator caps a single call at ~5000 chars; our texts are short.
        out = GoogleTranslator(source=src if src in _SUPPORTED else "auto", target=tgt).translate(text)
        cleaned = (out or "").strip()
        if not cleaned:
            return {"text": text, "translated": False, "source": src, "target": tgt}
        return {"text": cleaned, "translated": True, "source": src, "target": tgt}
    except Exception as e:  # network blocked / unsupported pair
        log.warning("translate failed (%s->%s): %s", src, tgt, e)
        return {"text": text, "translated": False, "source": src, "target": tgt, "warning": str(e)}
