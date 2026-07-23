# tts-service — Python speech engine

The real text-to-speech engine for the Support Ticker assistant. The Node
backend is only an **API façade**: it authenticates/validates the request and
proxies to this service. All synthesis lives here.

Replaces the old Node `google-tts-api` path (`src/tts.ts`) and the Node
`igbo-ssml` Claude-API bootstrapper.

## Stack

| Piece | Role |
|---|---|
| `espeak-ng` (binary) | actual audio rendering — text or IPA → WAV (→ MP3 optional) |
| `phonemizer` | grapheme→phoneme / IPA normalization |
| `lexicons/*.tsv` | bulk IPA lexicon per language (Igbo, Yoruba, …) |
| FastAPI + uvicorn | HTTP surface Node proxies to |

## Fallback policy

For a requested app language the engine picks, in order:

1. **Native voice** — espeak-ng has a voice for the language → speak directly.
2. **Approximate** — no native voice, but the text is phonemizable → resolve IPA
   (curated lexicon first, then phonemizer via a phonetically-near voice), speak
   the IPA with a base voice, return `approx: true` + a `warning`.
3. **Unavailable** — no voice and no phoneme route → `fallback: true` with an
   explicit `warning`. **English is never spoken silently**; the client decides
   whether to read the text in English *with a visible warning* or surface the
   error.

## Install

```bash
cd tts-service
python -m venv .venv && . .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r requirements.txt

# espeak-ng is a SYSTEM package (not pip):
#   Debian/Ubuntu : sudo apt-get install espeak-ng
#   macOS         : brew install espeak-ng
#   Windows       : https://github.com/espeak-ng/espeak-ng/releases (add to PATH)
# For MP3 output also install ffmpeg.
```

If phonemizer can't find the espeak shared library, set
`PHONEMIZER_ESPEAK_LIBRARY` (Linux example in the Dockerfile).

## Run

```bash
uvicorn app:app --host 0.0.0.0 --port 8081
# check capabilities (which voices/lexicons are live):
curl localhost:8081/health
```

`POST /synthesize` — body `{ "text": "...", "language": "ig" }` → returns:

```jsonc
{
  "audioBase64": "…",        // null when fallback
  "mime": "audio/wav",       // or audio/mpeg when TTS_AUDIO_FORMAT=mp3
  "fallback": false,          // true -> client uses browser speech synthesis
  "approx": true,             // Tier-2 approximate pronunciation
  "warning": "Igbo has no native espeak-ng voice; …",
  "voice": "sw",             // espeak voice actually used
  "language": "ig",
  "ipa": "ndèˈwó"
}
```

### Env

| Var | Default | Meaning |
|---|---|---|
| `TTS_AUDIO_FORMAT` | `wav` | `mp3` to encode MP3 (needs ffmpeg) |
| `TTS_CACHE_SIZE` | `200` | max cached clips (LRU) |
| `TTS_LOG_LEVEL` | `INFO` | logging level |

## Bulk IPA bootstrapping

Grow the lexicons offline (no API, no network) — this is the replacement for the
old `igbo-ssml` tool:

```bash
# phonemize a list and write out/ig.tsv + results.json/jsonl + combined.ssml
python bootstrap_ipa.py phrases.txt --lang ig

# append the results straight into ./lexicons/ig.tsv for runtime use
python bootstrap_ipa.py phrases.txt --lang ig --merge
```

Input: one phrase per line (blank/`#comment` lines ignored) or a JSON array of
strings. The `lexicons/*.tsv` files are read at service startup.

## Docker

```bash
docker build -t supportticket-tts .
docker run -p 8081:8081 supportticket-tts
```

## Roadmap

espeak-ng is the fast, reliable, offline baseline. For higher-quality Nigerian
language voices, the phoneme/lexicon work here feeds naturally into a trained
multilingual model later (e.g. Coqui XTTS or a fine-tuned African-language
voice) — swap the renderer in `engine.py` while keeping the same HTTP contract.
