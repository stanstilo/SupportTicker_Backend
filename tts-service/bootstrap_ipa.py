#!/usr/bin/env python3
"""
Bulk IPA bootstrapping — the offline replacement for the old `igbo-ssml` Node
tool. Instead of one Claude API call per phrase, this phonemizes an entire list
locally with espeak-ng (via phonemizer) in a single batched pass and writes:

  * <out>/<lang>.tsv       lexicon (surface\\tIPA)  -> drop into ./lexicons to
                           enable/improve runtime rendering for that language
  * <out>/results.json     [{original, ipa, respelling, ssml_phoneme,
                             ssml_fallback, approx}]  (same shape as before)
  * <out>/results.jsonl    one JSON object per line
  * <out>/combined.ssml    all <phoneme> snippets stitched into one <speak> doc

Usage:
    python bootstrap_ipa.py phrases.txt --lang ig [--out out] [--merge]

Input file: one phrase per line (blank lines and #comments ignored), OR a JSON
array of strings.

`--merge` appends new entries into ./lexicons/<lang>.tsv (keeping existing ones)
so you can grow the runtime lexicon incrementally.

Requires: espeak-ng binary + `phonemizer` (see requirements.txt). No API key,
no network.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import engine
import lexicon as lex

# --------------------------------------------------------------------------- #
# Input
# --------------------------------------------------------------------------- #
def read_phrases(path: Path) -> list[str]:
    raw = path.read_text(encoding="utf-8").strip()
    if raw.startswith("["):
        data = json.loads(raw)
        if not isinstance(data, list):
            raise ValueError("JSON input must be an array of strings")
        return [str(s).strip() for s in data if str(s).strip()]
    return [
        line.strip()
        for line in raw.splitlines()
        if line.strip() and not line.strip().startswith("#")
    ]


# --------------------------------------------------------------------------- #
# Derivations from IPA (respelling + SSML), no LLM
# --------------------------------------------------------------------------- #
# Best-effort IPA -> English-friendly respelling. Tuned for the vowel-rich,
# syllable-timed profile of Igbo/Yoruba; clearly approximate (approx=True).
_RESPELL = [
    ("t͡ʃ", "ch"), ("d͡ʒ", "j"), ("ɡ͡b", "gb"), ("k͡p", "kp"),
    ("ʃ", "sh"), ("ʒ", "zh"), ("ɲ", "ny"), ("ŋ", "ng"),
    ("ɛ", "e"), ("ɔ", "aw"), ("ə", "uh"), ("ɪ", "i"), ("ʊ", "u"),
    ("ɑ", "ah"), ("æ", "a"), ("ɓ", "b"), ("ɗ", "d"), ("ɣ", "gh"),
    ("β", "v"), ("ʔ", ""), ("ː", ""), ("ˈ", ""), ("ˌ", ""),
    ("j", "y"), ("x", "kh"), ("θ", "th"), ("ð", "dh"),
]


def respell(ipa: str) -> str:
    out = ipa
    for src, dst in _RESPELL:
        out = out.replace(src, dst)
    # drop remaining tone/diacritic combining marks
    out = "".join(ch for ch in out if not _is_combining(ch))
    return out.strip()


def _is_combining(ch: str) -> bool:
    import unicodedata

    return unicodedata.combining(ch) != 0


def ssml_phoneme(original: str, ipa: str) -> str:
    esc = original.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    ph = ipa.replace('"', "&quot;")
    return f'<speak><phoneme alphabet="ipa" ph="{ph}">{esc}</phoneme></speak>'


def ssml_fallback(respelled: str) -> str:
    # hyphenate on whitespace so phoneme-less engines get a syllable-ish hint
    hyph = "-".join(respelled.split())
    return f"<speak>{hyph}</speak>"


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #
def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Bulk IPA bootstrap via espeak-ng + phonemizer")
    ap.add_argument("phrases", nargs="?", default="phrases.txt", help="input file")
    ap.add_argument("--lang", "-l", default="ig", help="app language code (ig, yo, ha, ...)")
    ap.add_argument("--out", "-o", default="out", help="output directory")
    ap.add_argument("--merge", action="store_true",
                    help="append results into ./lexicons/<lang>.tsv")
    args = ap.parse_args(argv)

    if not engine.espeak_bin():
        print("error: espeak-ng not found on PATH. Install it first "
              "(see tts-service/README.md).", file=sys.stderr)
        return 2

    spec = engine.LANGS.get(args.lang.lower())
    espeak_lang = spec.espeak if spec else args.lang
    # If the exact voice/lang isn't phonemizable, fall back to the near voice.
    if engine.phonemize("test", espeak_lang) is None and spec:
        print(f"note: phonemizer has no '{espeak_lang}'; using near voice "
              f"'{spec.near}' (results are approximate).", file=sys.stderr)
        espeak_lang = spec.near

    phrases_path = Path(args.phrases)
    if not phrases_path.is_file():
        print(f"error: no such file: {phrases_path}", file=sys.stderr)
        return 2
    phrases = read_phrases(phrases_path)
    if not phrases:
        print(f"error: no phrases found in {phrases_path}", file=sys.stderr)
        return 1

    print(f"Bootstrapping {len(phrases)} phrase(s) for '{args.lang}' "
          f"via espeak-ng lang '{espeak_lang}'...", file=sys.stderr)

    results = []
    for i, phrase in enumerate(phrases, 1):
        ipa = engine.phonemize(phrase, espeak_lang)
        if not ipa:
            results.append({"original": phrase, "error": "phonemize_failed"})
            print(f"  [{i}/{len(phrases)}] {phrase}  (FAILED)", file=sys.stderr)
            continue
        rs = respell(ipa)
        results.append({
            "original": phrase,
            "ipa": ipa,
            "respelling": rs,
            "ssml_phoneme": ssml_phoneme(phrase, ipa),
            "ssml_fallback": ssml_fallback(rs),
            # espeak-ng derived => flag approximate unless a native voice exists
            "approx": engine.resolve_voice(espeak_lang) is None or spec is None
                      or engine.resolve_voice(spec.espeak) is None,
        })
        print(f"  [{i}/{len(phrases)}] {phrase} -> {ipa}", file=sys.stderr)

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    ok = [r for r in results if "ipa" in r]

    (out_dir / "results.json").write_text(
        json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    (out_dir / "results.jsonl").write_text(
        "\n".join(json.dumps(r, ensure_ascii=False) for r in results) + "\n",
        encoding="utf-8")

    body = "\n".join(
        f"  <!-- {r['original']}{' (IPA approx)' if r['approx'] else ''} -->\n"
        f"  {r['ssml_phoneme'].replace('<speak>', '').replace('</speak>', '').strip()}\n"
        f'  <break time="400ms"/>'
        for r in ok
    )
    (out_dir / "combined.ssml").write_text(
        f"<speak>\n{body}\n</speak>\n", encoding="utf-8")

    # lexicon TSV (surface -> IPA), keyed by the same normalizer the runtime uses
    tsv_lines = [f"{lex.normalize(r['original'])}\t{r['ipa']}" for r in ok]
    lex_path = out_dir / f"{args.lang.lower()}.tsv"
    lex_path.write_text("\n".join(tsv_lines) + "\n", encoding="utf-8")

    print(f"\nWrote {out_dir}/results.json, results.jsonl, combined.ssml, "
          f"{lex_path.name}", file=sys.stderr)

    if args.merge:
        merged = _merge_lexicon(args.lang.lower(), {
            lex.normalize(r["original"]): r["ipa"] for r in ok
        })
        print(f"Merged into {merged} ({lex.Lexicon.load_default().size(args.lang.lower())} "
              f"entries before merge).", file=sys.stderr)

    failed = [r for r in results if "error" in r]
    if failed:
        print(f"  {len(failed)} failed — see the 'error' field in results.json",
              file=sys.stderr)
    return 0


def _merge_lexicon(lang: str, new_entries: dict[str, str]) -> Path:
    """Union new entries into ./lexicons/<lang>.tsv, new values win on conflict."""
    target = lex.LEXICON_DIR / f"{lang}.tsv"
    lex.LEXICON_DIR.mkdir(parents=True, exist_ok=True)
    existing: dict[str, str] = {}
    if target.is_file():
        existing = lex.Lexicon._read_tsv(target)  # noqa: SLF001 (shared format)
    existing.update(new_entries)
    lines = [f"# {lang} IPA lexicon (bootstrapped + merged)"]
    lines += [f"{k}\t{v}" for k, v in sorted(existing.items())]
    target.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return target


if __name__ == "__main__":
    raise SystemExit(main())
