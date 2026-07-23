"""
Bulk IPA lexicon — per-word pronunciations used to improve (and, for languages
espeak-ng can't speak, to *enable*) Igbo/Yoruba/... rendering.

A lexicon is a plain TSV file, one entry per line:

    <surface form>\t<IPA>

loaded from ./lexicons/<lang>.tsv (e.g. lexicons/ig.tsv). Comments (`#`) and
blank lines are ignored. Entries are matched case-insensitively.

`bootstrap_ipa.py` writes these files in bulk from a word/phrase list, so the
lexicon and the runtime lookup share one format. Phrase-level entries (multiple
words) are matched whole first; otherwise we stitch a phrase's IPA together from
its individual word entries so unseen combinations still resolve.
"""

from __future__ import annotations

import logging
import re
from pathlib import Path

log = logging.getLogger("tts.lexicon")

LEXICON_DIR = Path(__file__).resolve().parent / "lexicons"

# Word tokenizer shared with the bootstrap CLI: keep Latin letters plus the
# Igbo/Yoruba dotted/underdot vowels and combining diacritics as part of a word.
_WORD_RE = re.compile(r"[^\s]+")


def normalize(word: str) -> str:
    """Lowercase and strip surrounding punctuation for stable keys."""
    return word.strip().strip(".,;:!?\"'()[]{}").lower()


def tokenize(text: str) -> list[str]:
    return [t for t in (normalize(w) for w in _WORD_RE.findall(text)) if t]


class Lexicon:
    """In-memory {lang: {word_or_phrase: ipa}} store."""

    def __init__(self, tables: dict[str, dict[str, str]] | None = None):
        self._tables: dict[str, dict[str, str]] = tables or {}

    # -- loading ----------------------------------------------------------- #
    @classmethod
    def load_default(cls, directory: Path | None = None) -> "Lexicon":
        directory = directory or LEXICON_DIR
        tables: dict[str, dict[str, str]] = {}
        if not directory.is_dir():
            log.info("No lexicon directory at %s; running lexicon-free.", directory)
            return cls(tables)
        for path in sorted(directory.glob("*.tsv")):
            lang = path.stem.lower()
            tables[lang] = cls._read_tsv(path)
            log.info("Loaded %d %s lexicon entries from %s", len(tables[lang]), lang, path.name)
        return cls(tables)

    @staticmethod
    def _read_tsv(path: Path) -> dict[str, str]:
        table: dict[str, str] = {}
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.rstrip("\n")
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            parts = line.split("\t")
            if len(parts) < 2:
                continue
            key = normalize(parts[0])
            ipa = parts[1].strip()
            if key and ipa:
                table[key] = ipa
        return table

    # -- lookup ------------------------------------------------------------ #
    def ipa_for_text(self, lang: str, text: str) -> str | None:
        """
        Resolve `text` to IPA using the lexicon:

          1. exact phrase match (whole normalized string), else
          2. join per-word IPA — but only if EVERY word is known, so we never
             emit a half-transcribed string that would mispronounce silently.

        Returns None when the lexicon can't fully cover the text.
        """
        table = self._tables.get(lang.lower())
        if not table:
            return None

        whole = normalize(text)
        if whole in table:
            return table[whole]

        words = tokenize(text)
        if not words:
            return None
        parts = [table.get(w) for w in words]
        if all(parts):
            return " ".join(p for p in parts if p)  # type: ignore[misc]
        return None

    def languages(self) -> list[str]:
        return sorted(self._tables)

    def size(self, lang: str) -> int:
        return len(self._tables.get(lang.lower(), {}))
