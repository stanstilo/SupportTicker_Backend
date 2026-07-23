"""
Core TTS engine — the real speech path for the Support Ticker assistant.

Node is only an API façade; all synthesis happens here:

  * `espeak-ng` (binary)  — actual audio rendering (text/IPA -> WAV, optional MP3)
  * `phonemizer`          — grapheme->phoneme / IPA normalization
  * a bulk IPA lexicon    — per-word Igbo/Yoruba/... pronunciations (see lexicon.py)

Fallback policy (exactly what the app promises to users):

  Tier 1  native voice exists   -> synthesize directly with that espeak-ng voice.
  Tier 2  no native voice but    -> phonemize (custom lexicon first, then a
          the text is phonemizable   phonetically-near voice), speak the IPA with a
                                      base voice, and flag `approx=True` + a warning.
  Tier 3  unsupported, no phoneme -> DO NOT silently speak English. Return
          route at all                `fallback=True` with an explicit warning so the
                                      client can either fall back to `en` *with a
                                      visible warning* or surface the error.

Everything here is defensive: a missing binary, an unknown language, or a broken
phonemizer never raises to the caller — it degrades to a `fallback` result.
"""

from __future__ import annotations

import base64
import functools
import logging
import re
import shutil
import subprocess
from dataclasses import dataclass, field
from typing import Optional

from lexicon import Lexicon

log = logging.getLogger("tts.engine")

# --------------------------------------------------------------------------- #
# Language configuration
# --------------------------------------------------------------------------- #
# App language code -> engine strategy. `espeak` is the espeak-ng voice we'd
# like to use; `near` is the phonetically-closest voice to borrow when the
# preferred voice isn't installed (Tier 2). `phonemize_lang` is the language
# code we hand to phonemizer for IPA (usually == espeak).
#
# NOTE: whether a voice actually exists is decided at runtime from
# `espeak-ng --voices`, not from this table — espeak-ng builds vary. This table
# only expresses intent and the Tier-2 fallback preference.


@dataclass(frozen=True)
class LangSpec:
    espeak: str  # preferred espeak-ng voice name/code
    near: str  # phonetically-nearest voice to borrow for Tier 2
    label: str  # human name (for warnings/logs)


LANGS: dict[str, LangSpec] = {
    "en": LangSpec(espeak="en-us", near="en-us", label="English"),
    "fr": LangSpec(espeak="fr-fr", near="fr-fr", label="French"),
    # African languages. espeak-ng's coverage here is uneven across builds:
    # `ha`/`yo` exist in recent builds; `ig` (Igbo) frequently does NOT, so it
    # leans on the lexicon + a near voice. `sw` (Swahili) is a reasonable
    # 5-vowel, syllable-timed stand-in for rendering borrowed IPA.
    "ha": LangSpec(espeak="ha", near="sw", label="Hausa"),
    "yo": LangSpec(espeak="yo", near="sw", label="Yoruba"),
    "ig": LangSpec(espeak="ig", near="sw", label="Igbo"),
}

DEFAULT_LANG = "en"
MAX_TEXT = 1200  # guard against very long inputs (matches the old Node cap)


# --------------------------------------------------------------------------- #
# Result type
# --------------------------------------------------------------------------- #
@dataclass
class TtsResult:
    audio_base64: Optional[str] = None
    mime: str = "audio/wav"
    fallback: bool = False  # True -> client should use browser speech synthesis
    approx: bool = False  # True -> pronunciation is approximate (Tier 2)
    warning: Optional[str] = None  # human-readable note for the UI
    voice: Optional[str] = None  # espeak voice actually used
    language: Optional[str] = None  # resolved app language
    ipa: Optional[str] = None  # IPA transcription, when computed

    def to_dict(self) -> dict:
        return {
            "audioBase64": self.audio_base64,
            "mime": self.mime,
            "fallback": self.fallback,
            "approx": self.approx,
            "warning": self.warning,
            "voice": self.voice,
            "language": self.language,
            "ipa": self.ipa,
        }


def _fallback(language: str, warning: str, ipa: Optional[str] = None) -> TtsResult:
    return TtsResult(fallback=True, warning=warning, language=language, ipa=ipa)


# --------------------------------------------------------------------------- #
# espeak-ng discovery
# --------------------------------------------------------------------------- #
def espeak_bin() -> Optional[str]:
    """Path to the espeak-ng (or espeak) binary, or None if not installed."""
    return shutil.which("espeak-ng") or shutil.which("espeak")


@functools.lru_cache(maxsize=1)
def _voice_index() -> dict[str, str]:
    """
    Map every espeak-ng voice code/identifier -> its canonical voice code.

    Parses `espeak-ng --voices`. The output columns are:
        Pty Language Age/Gender VoiceName          File          Other Langs
    We index both the Language code (col 2) and the File basename so lookups by
    either `yo` or `gmw/en-US` succeed. Cached — voices don't change at runtime.
    """
    binary = espeak_bin()
    if not binary:
        return {}
    try:
        out = subprocess.run(
            [binary, "--voices"],
            capture_output=True,
            text=True,
            timeout=15,
            check=True,
        ).stdout
    except (subprocess.SubprocessError, OSError) as exc:  # pragma: no cover
        log.warning("espeak-ng --voices failed: %s", exc)
        return {}

    index: dict[str, str] = {}
    for line in out.splitlines()[1:]:  # skip header
        cols = line.split()
        if len(cols) < 4:
            continue
        lang_code = cols[1].lower()  # e.g. "en-us", "yo", "ha"
        file_id = cols[3].lower()  # e.g. "gmw/en-us"
        index[lang_code] = lang_code
        index[file_id] = lang_code
        # also index the trailing "Other langs" tokens so aliases resolve
        for extra in cols[4:]:
            index.setdefault(extra.lower(), lang_code)
    return index


def resolve_voice(code: str) -> Optional[str]:
    """Return the installed espeak voice for `code`, trying exact then base match."""
    if not code:
        return None
    idx = _voice_index()
    code = code.lower()
    if code in idx:
        return idx[code]
    base = code.split("-")[0]
    if base in idx:
        return idx[base]
    # any voice whose code starts with the base (e.g. "en" -> "en-us")
    for key, val in idx.items():
        if key.split("-")[0] == base:
            return val
    return None


# --------------------------------------------------------------------------- #
# phonemizer (IPA) — imported lazily so the service still boots without it
# --------------------------------------------------------------------------- #
@functools.lru_cache(maxsize=1)
def _phonemizer_available() -> bool:
    try:
        import phonemizer  # noqa: F401

        return True
    except Exception as exc:  # pragma: no cover - env-dependent
        log.warning("phonemizer not importable: %s", exc)
        return False


@functools.lru_cache(maxsize=8)
def _espeak_backend(lang: str):
    """Cache one phonemizer EspeakBackend per language (backend init is costly)."""
    from phonemizer.backend import EspeakBackend

    return EspeakBackend(
        lang,
        preserve_punctuation=True,
        with_stress=True,
        language_switch="remove-flags",
        words_mismatch="ignore",
    )


def phonemize(text: str, espeak_lang: str) -> Optional[str]:
    """
    Grapheme -> IPA via phonemizer's espeak backend. Returns None if phonemizer
    or the language is unavailable. Used for Tier-2 approximate rendering and by
    the bulk bootstrap CLI.
    """
    if not _phonemizer_available():
        return None
    try:
        from phonemizer.backend import EspeakBackend

        if espeak_lang not in EspeakBackend.supported_languages():
            return None
        ipa = _espeak_backend(espeak_lang).phonemize([text], strip=True)
        return (ipa[0] if ipa else "").strip() or None
    except Exception as exc:  # pragma: no cover
        log.warning("phonemize(%r, %s) failed: %s", text, espeak_lang, exc)
        return None


# --------------------------------------------------------------------------- #
# Audio rendering
# --------------------------------------------------------------------------- #
# espeak-ng speaks a raw IPA string when it's wrapped as [[...]] phoneme input.
# We sanitize the IPA to the subset espeak accepts to avoid it reading stray
# characters literally.
_IPA_STRIP = re.compile(r"[^\w ˈˌːˑ.aeiouɛɔɪʊəɨʌæɑɒøœyɓɗʄɠʛβθðʃʒçʝxɣħʁʔ"
                        r"pbtdʈɖcɟkgqɢmnɳɲŋɴrɾ lʎʟjwɥhɦ̃ʰʷⁿ˥˦˧˨˩̀́̂̄̆]+")


def _render_wav(binary: str, arg: str, voice: str, is_ipa: bool,
                rate: int = 155, pitch: int = 50) -> Optional[bytes]:
    """
    Run espeak-ng and return WAV bytes (via --stdout), or None on failure.

    `is_ipa=True` speaks `arg` as an IPA/phoneme string ([[...]]); otherwise it
    speaks `arg` as ordinary text in `voice`.
    """
    payload = f"[[{arg}]]" if is_ipa else arg
    cmd = [binary, "-v", voice, "-s", str(rate), "-p", str(pitch), "--stdout", payload]
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=30, check=True)
    except (subprocess.SubprocessError, OSError) as exc:
        log.warning("espeak render failed (voice=%s ipa=%s): %s", voice, is_ipa, exc)
        return None
    data = proc.stdout
    # espeak-ng emits a valid RIFF/WAVE header on --stdout; sanity-check it.
    if not data or data[:4] != b"RIFF":
        log.warning("espeak produced no WAV (voice=%s)", voice)
        return None
    return data


def _to_mp3(wav: bytes) -> Optional[bytes]:
    """Best-effort WAV->MP3 via pydub+ffmpeg. Returns None if unavailable."""
    if not (shutil.which("ffmpeg") or shutil.which("avconv")):
        return None
    try:
        import io

        from pydub import AudioSegment

        seg = AudioSegment.from_wav(io.BytesIO(wav))
        buf = io.BytesIO()
        seg.export(buf, format="mp3", bitrate="64k")
        return buf.getvalue()
    except Exception as exc:  # pragma: no cover - env-dependent
        log.warning("mp3 conversion failed, keeping wav: %s", exc)
        return None


# --------------------------------------------------------------------------- #
# Public entry point
# --------------------------------------------------------------------------- #
class Engine:
    """
    Holds the lexicon and renders speech. One instance is created at startup and
    reused across requests (espeak/phonemizer state is cached at module level).
    """

    def __init__(self, lexicon: Optional[Lexicon] = None, prefer_mp3: bool = False):
        self.lexicon = lexicon or Lexicon.load_default()
        self.prefer_mp3 = prefer_mp3

    def _package(self, wav: bytes, **kwargs) -> TtsResult:
        """Wrap WAV bytes into a TtsResult, converting to MP3 if requested/possible."""
        mime = "audio/wav"
        data = wav
        if self.prefer_mp3:
            mp3 = _to_mp3(wav)
            if mp3:
                data, mime = mp3, "audio/mpeg"
        return TtsResult(
            audio_base64=base64.b64encode(data).decode("ascii"),
            mime=mime,
            **kwargs,
        )

    def synthesize(self, raw_text: str, app_lang: Optional[str]) -> TtsResult:
        text = (raw_text or "").strip()[:MAX_TEXT]
        lang = (app_lang or DEFAULT_LANG).lower()
        if not text:
            return _fallback(lang, "Empty text.")

        binary = espeak_bin()
        if not binary:
            # No engine at all -> client uses browser synthesis.
            return _fallback(lang, "espeak-ng is not installed on the server.")

        spec = LANGS.get(lang)
        if spec is None:
            # Unknown app language: try the code directly as an espeak voice.
            voice = resolve_voice(lang)
            if voice:
                wav = _render_wav(binary, text, voice, is_ipa=False)
                if wav:
                    return self._package(wav, voice=voice, language=lang)
            return _fallback(lang, f"Unsupported language '{lang}'.")

        # -- Tier 1: native voice installed -> speak directly ------------------
        native = resolve_voice(spec.espeak)
        if native:
            wav = _render_wav(binary, text, native, is_ipa=False)
            if wav:
                return self._package(wav, voice=native, language=lang)
            # espeak had a native voice but failed to render; fall through.

        # -- Tier 2: no native voice, but we can phonemize ---------------------
        # Prefer curated per-word IPA from the lexicon; fall back to phonemizing
        # the whole phrase with a phonetically-near voice.
        ipa = self.lexicon.ipa_for_text(lang, text)
        source = "lexicon"
        if not ipa:
            ipa = phonemize(text, spec.espeak) or phonemize(text, spec.near)
            source = "phonemizer"

        if ipa:
            near_voice = resolve_voice(spec.near) or resolve_voice(DEFAULT_LANG)
            if near_voice:
                clean = _IPA_STRIP.sub(" ", ipa).strip()
                wav = _render_wav(binary, clean, near_voice, is_ipa=True)
                if wav:
                    return self._package(
                        wav,
                        approx=True,
                        voice=near_voice,
                        language=lang,
                        ipa=ipa,
                        warning=(
                            f"{spec.label} has no native espeak-ng voice; "
                            f"pronunciation is approximate ({source} IPA via "
                            f"'{near_voice}')."
                        ),
                    )

        # -- Tier 3: no voice, no phoneme route -------------------------------
        # Never silently speak English. Signal fallback so the client shows a
        # visible warning (and may choose to read the text in English itself).
        return _fallback(
            lang,
            f"{spec.label} pronunciation is unavailable on the server "
            f"(no espeak-ng voice and no phoneme route). "
            f"Falling back to browser speech synthesis.",
            ipa=ipa,
        )
