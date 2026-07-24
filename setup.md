##
seeded accounts
admin@gifsonservices.onmicrosoft.com, superadmin@gifsonservices.onmicrosoft.com, boomarobe@gifsonservices.onmicrosoft.com, royal@gifsonservices.onmicrosoft.com, souncloner@gifsonservices.onmicrosoft.com, yalebstech@gifsonservices.onmicrosoft.com, ada@gifsonservices.onmicrosoft.com, clara@gifsonservices.onmicrosoft.com, stephen@gifsonservices.onmicrosoft.com

##
https://app.dojah.io/developers/
 Test info
 { 
 NIN: 70123456789
 BVN	22222222222
First name	John
Middle name	Doe
Last name	Adamu
Full name	John Doe Adamu
Date of birth	2000-05-01
Gender	Male
Phone number	07012345678
Customer ID	6bb82c41-e15e-4308-b99d-e9640818eca9
 }
 ### payment, account opening, retail banking, lending, fraud prevention, KYC

 ## To use self hosted faster whisper, 
 use nueral mms tts
 cd SupportTicket-Backend/tts-service
python -m uvicorn app:app --host 127.0.0.1 --port 8081

## For native language models use 
Coqui XTTS = noticeably slower, especially on CPU-only
Meta mms-tts neural for python service 
MozillaTTS
Tortoise TTS
Eleven Labs
rnjema-unima/mms-tts-ibo-baseline is a public VITS Igbo model
also the real igbo capability lives here -  Meta MMS-1B ASR (facebook/mms-1b-all) ~ 3.5gb

## 
### 1. Use native conversation tts
Native-language TTS pattern
Use a two-stage strategy:

Prefer a real native voice

Detect available voices and score them for the target language.
If a trusted native voice exists, send the original text unchanged.
This is the best quality path.
Otherwise normalize the text for the speech engine

Convert the text into an English-friendly pronunciation string.
For example, French bonjour → bohn zhoor.

2. 
### Best-practice flow
Voice detection

Query available voices.
Score by language tag / voice name.
Prefer exact native voices (fr-FR, ig, yo, ha, etc.).
Use lexicons first

Match multi-word phrases before single words.
Lookup exact words in a curated lexicon.
This gives the most accurate pronunciation for common content.
Fallback with phonetic rules

If a word is not in the lexicon, apply rule-based phonetic respelling.
Handle language-specific features like:
nasal vowels
digraphs
silent final consonants
contractions and elisions
Retry safely

If the first TTS attempt fails, clear cached voice info.
Retry with a more conservative fallback path.
Expose quality metadata

Return flags like approx: true or warning.
Let the client know when pronunciation is approximate.

###
Note: You can use the browser’s Web Speech API speech recognition: streaming is when appears as you speak it is quite faster 


###
### LIVENESS ID PROMPT 
liveness,  Summary: perform document authenticity first; only if the ID is demonstrably real run selfie+active liveness; if the ID fails, don't trust the liveness result — ask user to re‑upload or offer a lower‑assurance fallback plus manual review.

Intake: capture ID image, metadata (type, file name), and a live selfie (data URLs). Timestamp & store evidence.
Step 1 — Document authenticity check (automated): OCR + format/MRZ/field checks + security‑feature heuristics. If doc is readable and passes checks → proceed.
Step 2 — Face match + liveness (authoritative path): require a selfie and run (a) face match (selfie vs. ID) and (b) active liveness (challenge/nonce) or strong passive liveness. Accept only if both meet thresholds (e.g., matchScore ≥ 70 AND liveness ≥ 70). Good result → mark verified, persist audit record, grant normal access.
If face match or liveness fail → request re-capture (limit 2–3 retries), with clear guidance and examples; after retries fail → escalate to manual review.
If document authenticity fails (unreadable, tampered, forged indicators):
Do NOT treat a subsequent selfie match as authoritative against that document.
Immediately ask the user to re‑upload a clearer/real ID OR
Offer an explicit fallback: “selfie-only verification” with user consent — treat outcome as low assurance, limit privileges, and Good result → mark verified, persist audit record, grant normal access.
If face match or liveness fail → request re-capture (limit 2–3 retries), with clear guidance and examples; after retries fail → escalate to manual review.
If document authenticity fails (unreadable, tampered, forged indicators):
Do NOT treat a subsequent selfie match as authoritative against that document.
Immediately ask the user to re‑upload a clearer/real ID OR
Offer an explicit fallback: “selfie-only verification” with user consent — treat outcome as low assurance, limit privileges, and Shortest rule: "Document authenticity first → only then do liveness; if the ID is invalid, don’t accept selfie‑matching as proof — either re‑request a valid ID or run a consented, limited selfie‑only flow plus manual review."


### LIVENESS DOJAH'S SERVICE
I am using the single-image /ml/liveness API for test but for real livenes use  active liveness — Dojah's liveness SDK/widget 