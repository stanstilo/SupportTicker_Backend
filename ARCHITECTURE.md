# Conversation / Voice Pipeline Architecture

How a chat message flows end-to-end (text **and** voice), and the speech-output
ordering **before vs after** neural MMS-TTS was added.

The input → STT → translate → RAG → text pipeline is identical before/after; the
MMS-TTS change only reorders the **speech-reply tier** for native languages
(Igbo / Yorùbá / Hausa).

---

## 1. Overall conversation flow

```
USER INPUT ─┬─ typed text ─────────────────────────────────────────────┐
            └─ voice ─► MediaRecorder ─► POST /api/assistant/stt         │
                         (Node) ─► Python /transcribe                    │
                         Whisper: tiny = live partials, base = final     │
                         en/yo/ha ✓    ig ✗ (unsupported → "please type")│
                                                                         │
                                                                         ▼
                                     transcript / typed text (native or English)
                                                                         │
                 if native ─► POST Python /translate (deep_translator)  native → EN
                                                                         │
                                                                         ▼
   RAG  (POST /api/assistant):   Supabase vector  →  Supabase keyword
                                 →  OpenAI LLM  →  LOCAL extractive RAG
                                 (greeting/help shortcuts; generic fallback)
                                                                         │
                 if native ─► POST /translate   EN → native (translate the answer)
                                                                         │
                                                                         ▼
                 ┌─────────────────────────────────────────────────────┐
                 │  TEXT reply   → always rendered in the chat bubble    │
                 │  SPEECH reply → only when the question came by VOICE  │ ─► speak()
                 └─────────────────────────────────────────────────────┘
```

Rule: **you get text always; you get speech only if you asked by voice**
(`processUserText(text, viaVoice)` calls `speak()` only when `viaVoice` is true).

---

## 2. Speech reply (TTS) — BEFORE MMS-TTS

For a native-language reply (ig / yo / ha), `speak()` tried, in order:

```
1. Browser native voice (Web Speech)          ← almost never exists for ig/yo/ha
2. Phonetic RESPELL + English browser voice    ← what actually ran ➜ ROBOTIC
3. Server espeak (/assistant/tts)               ← only if no browser synthesis
```

Result: Igbo/Yorùbá/Hausa = an English voice reading `"n-deh-wo…"` — robotic,
not a native speaker.

---

## 3. Speech reply (TTS) — AFTER MMS-TTS

```
NATIVE (ig / yo / ha):
1. ★ Server NEURAL MMS-TTS  ── POST /api/assistant/tts ─► Python /synthesize
      facebook/mms-tts-yor, facebook/mms-tts-hau,
      Igbo = public VITS mirror (rnjema-unima/mms-tts-ibo-baseline)   ➜ AUTHENTIC
      (→ server espeak native/phonemized when MMS isn't installed)
2. Browser native voice (if installed)
3. Phonetic respell + English voice   ← keeps the reply audible, flagged approx
      └─ tiers 2–3 are fallbacks only when the server voice isn't available
         (TTS service down / MMS not installed)

ENGLISH:
1. Browser native voice (natural / neural preferred, robotic ones penalized)
2. Server espeak (last resort)
```

**One-line difference**
- **Before:** native speech = browser phonetic respell (robotic English voice).
- **After:** native speech = server neural MMS-TTS first (real ig/yo/ha voice);
  respell demoted to a last-resort fallback so the reply is still spoken (never
  silent) when no native voice is available.

---

## 4. Component / tier summary

| Stage | Engine (primary → fallback) |
|---|---|
| **STT** | self-hosted Whisper `base` (final) / `tiny` (partials) → OpenAI Whisper. **Igbo unsupported** by Whisper. |
| **Translate** | Python `deep_translator` (Google Translate) — native ↔ English |
| **Retrieve** | Supabase pgvector (OpenAI embeddings) → Supabase keyword (no-embeddings, token overlap) |
| **Generate** | OpenAI LLM → local extractive RAG (works with no OpenAI/quota) |
| **TTS — before** | browser respell → espeak |
| **TTS — after** | **MMS-TTS neural** → browser native → respell (approx, so never silent) → espeak |

---

## 5. Services & endpoints

- **Frontend** (Vite/React, `../SupportTicket`)
  - `src/lib/audioRecorder.ts` — mic capture (MediaRecorder), streaming chunks for partials
  - `src/lib/speech.ts` — `speak()` cascade (server MMS → browser native → respell)
  - `src/lib/pronunciation.ts` — phonetic respelling (phrases → word lexicon → rules)
  - `src/features/chat/ChatWidget.tsx` — orchestration
- **Node backend** (Fastify, `src/`)
  - `POST /api/assistant` — RAG (`src/routes/assistant.ts`)
  - `POST /api/assistant/stt` — proxy → Python (`src/stt.ts`)
  - `POST /api/assistant/tts` — proxy → Python (`src/tts.ts`)
  - `src/translate.ts` — proxy → Python `/translate`
- **Python service** (FastAPI, `tts-service/`)
  - `POST /transcribe` — faster-whisper STT (`stt.py`)
  - `POST /synthesize` — MMS-TTS neural → espeak (`mms_tts.py`, `engine.py`)
  - `POST /translate` — deep_translator (`translate.py`)
  - `GET  /health` — reports `stt`, `sttModel`, `translate`, `mms`, `mmsLangs`

---

## 6. Key configuration (env)

| Var | Purpose | Default |
|---|---|---|
| `OPENAI_API_KEY` | assistant LLM + embeddings + STT fallback | — (currently out of quota → local paths used) |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | knowledge base | — |
| `TTS_SERVICE_URL` / `STT_SERVICE_URL` / `TRANSLATE_SERVICE_URL` | Python service base | `http://127.0.0.1:8081` |
| `WHISPER_MODEL` / `WHISPER_PARTIAL_MODEL` | STT accuracy vs speed | `base` / `tiny` |
| `WHISPER_VAD`, `WHISPER_BEAM_SIZE`, `WHISPER_CPU_THREADS` | STT tuning | `true`, `1`, `0` (auto) |
| `MMS_TTS`, `MMS_MODEL_IG/YO/HA`, `HF_TOKEN` | neural TTS (opt-in via `requirements-mms.txt`) | `auto`, public mirrors, — |
| `DOJAH_APP_ID` / `DOJAH_API_KEY` | KYC (BVN/NIN/document/face) | — |

**Deploy note:** neural MMS-TTS deps (`torch`, `transformers`) live in
`tts-service/requirements-mms.txt` (NOT the base requirements), so the free-tier
build stays lean; MMS activates only where those are installed.

---

## 7. Known limitations

- **Igbo speech-to-text**: Whisper has no Igbo model; ig voice input returns
  `unsupported` and the UI asks the user to type. Igbo **text in** and **neural
  speech out** both work. Real Igbo STT would need Meta MMS-1B ASR
  (~3.5 GB / ~4 GB RAM) — not wired.
- **OpenAI quota**: the configured key is out of quota, so the assistant runs on
  the local keyword-retrieval + extractive-RAG path, and STT/TTS use the
  self-hosted engines. Adding credits re-enables the OpenAI tiers automatically.


##
Sample STT yoruba to English - Ba wo ni mo se le si akanti akeeko