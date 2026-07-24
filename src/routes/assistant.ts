import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { synthesizeSpeech } from '../tts'
import { transcribeAudio } from '../stt'
import { translateText } from '../translate'

/**
 * Supabase-backed RAG assistant.
 *
 * This route uses OpenAI embeddings + completions and a Supabase pgvector search
 * RPC. The Supabase project should expose a function named
 * `match_support_documents` that returns the nearest documents for a query
 * embedding.
 *
 * Example function signature in Postgres:
 *
 * create or replace function public.match_support_documents(
 *   query_embedding double precision[],
 *   match_count integer
 * ) returns table(
 *   id uuid,
 *   title text,
 *   excerpt text,
 *   content text,
 *   source text
 * ) as $$
 * select id, title, excerpt, content, source
 * from public.support_documents
 * -- query_embedding arrives as double precision[] (PostgREST JSON array);
 * -- cast to vector so pgvector's <-> distance operator applies.
 * order by content_embedding <-> query_embedding::vector
 * limit match_count;
 * $$ language sql stable;
 *
 * Index it with HNSW (not ivfflat): `create index ... using hnsw
 * (content_embedding vector_l2_ops)`. An ivfflat index on a small table makes
 * the default probes=1 search miss and return 0 rows. The
 * scripts/supabase-support-docs-pipeline.ts pipeline provisions all of this.
 */

interface AssistantRequest {
  message?: string
  history?: Array<{ role: 'user' | 'assistant'; content: string }>
  language?: string
}

/** Supported conversation languages. The assistant answers (and the canned
 *  greeting / no-match fallback) in the selected language. Translations are
 *  best-effort and worth a native-speaker review. */
type LangCode = 'en' | 'ig' | 'yo' | 'ha'
const LOCALES: Record<LangCode, { name: string; greeting: string; noMatch: string; help: string }> = {
  en: {
    name: 'English',
    greeting: "Hello — I'm here and ready to help. How may I assist you today?",
    noMatch:
      "I couldn't find a matching answer in our knowledge base. I can help you log a support request so the right team can follow up.",
    help: "I can answer questions from our knowledge base — things like opening an account, resetting your password, cards, transfers, and ticket policies. Ask me a question, or I can help you log a support request.",
  },
  ig: {
    name: 'Igbo',
    greeting: 'Ndewo — anọ m ebe a ịnyere gị aka. Kedu ka m ga-esi nyere gị aka taa?',
    noMatch:
      'Ahụghị m azịza dabara na ntọala ihe ọmụma anyị. Enwere m ike inyere gị aka idebanye arịrịọ nkwado ka ndị otu kwesịrị ekwesị nyochaa ya.',
    help: 'Enwere m ike ịza ajụjụ site na ntọala ihe ọmụma anyị — dịka imepe akaụntụ, ịtọgharị okwuntughe, kaadị, ntụfe ego, na iwu tiketi. Jụọ m ajụjụ, ma ọ bụ ka m nyere gị aka idebanye arịrịọ nkwado.',
  },
  yo: {
    name: 'Yoruba',
    greeting: 'Pẹlẹ o — mo wà níbí láti ràn ọ́ lọ́wọ́. Báwo ni mo ṣe lè ràn ọ́ lọ́wọ́ lónìí?',
    noMatch:
      'Nkò rí ìdáhùn tó bá a mu nínú ibi ìpamọ́ ìmọ̀ wa. Mo lè ràn ọ́ lọ́wọ́ láti forúkọ ìbéèrè àtìlẹ́yìn sílẹ̀ kí ẹgbẹ́ tó yẹ lè tẹ̀lé e.',
    help: 'Mo lè dáhùn àwọn ìbéèrè láti inú ibi ìpamọ́ ìmọ̀ wa — bíi ṣíṣí àkántì, àtúntò ọ̀rọ̀ ìwọlé, káàdì, gbígbé owó, àti òfin tíkẹ́ẹ̀tì. Bi mí léèrè, tàbí kí n ràn ọ́ lọ́wọ́ láti forúkọ ìbéèrè àtìlẹ́yìn sílẹ̀.',
  },
  ha: {
    name: 'Hausa',
    greeting: 'Sannu — ina nan don taimaka maka. Yaya zan iya taimaka maka yau?',
    noMatch:
      'Ban sami amsa mai dacewa a cikin ma’ajin ilimin mu ba. Zan iya taimaka maka shigar da buƙatar tallafi domin ƙungiyar da ta dace ta biyo baya.',
    help: 'Zan iya amsa tambayoyi daga ma’ajin ilimin mu — kamar buɗe asusu, sake saita kalmar sirri, katunan, tura kuɗi, da ƙa’idodin tikiti. Ka yi mini tambaya, ko in taimaka maka shigar da buƙatar tallafi.',
  },
}
const resolveLang = (value: unknown): LangCode =>
  value === 'ig' || value === 'yo' || value === 'ha' ? value : 'en'

interface SupportDocument {
  id: string
  title: string
  excerpt: string
  content: string
  source?: string
}

interface AssistantResponse {
  answer: string
  sources: Array<Pick<SupportDocument, 'title' | 'excerpt' | 'source'>>
  /** Which cascade stage produced the answer (for observability). */
  stage?: string
}

interface SupabaseEnv {
  url: string
  key: string
}

interface OpenAIEnv {
  key: string
  model: string
  embeddingModel: string
}

function readSupabaseEnv(): SupabaseEnv | null {
  const url = process.env.SUPABASE_URL?.trim()
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || process.env.SUPABASE_ANON_KEY?.trim()
  if (!url || !key) return null
  return { url: url.replace(/\/+$/, ''), key }
}

function readOpenAIEnv(): OpenAIEnv | null {
  const key = process.env.OPENAI_API_KEY?.trim()
  if (!key) return null
  return {
    key,
    model: process.env.OPENAI_MODEL?.trim() || 'gpt-4.1-mini',
    embeddingModel: process.env.OPENAI_EMBEDDING_MODEL?.trim() || 'text-embedding-3-large',
  }
}

function buildSystemPrompt(languageName: string): string {
  return `You are a professional support assistant for a ticketing and knowledge system. Answer the user's question directly, using only information available from the provided knowledge documents.

- Respond entirely in ${languageName}, even when the documents or the question are in a different language. Translate any information you use from the documents into ${languageName}.
- Keep your tone conversational, helpful, and concise. Phrase responses naturally for both text and speech output.
- Use only the provided documents. Do not invent answers or guess beyond the available content.
- If the answer is not contained in the documents, say the exact information is unavailable and offer to log a support request so the right team can follow up.
- Always mention the most relevant document sources when they exist.`
}

async function fetchOpenAIEmbedding(openai: OpenAIEnv, text: string): Promise<number[]> {
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${openai.key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: openai.embeddingModel, input: text }),
  })

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`OpenAI embeddings failed (${res.status}) ${detail.slice(0, 300)}`)
  }

  const body = (await res.json()) as { data?: Array<{ embedding: number[] }> }
  const embedding = body.data?.[0]?.embedding
  if (!embedding) throw new Error('OpenAI embeddings returned no vector')
  return embedding
}

async function searchSupportDocuments(query: string, limit = 4): Promise<SupportDocument[]> {
  const supabase = readSupabaseEnv()
  const openai = readOpenAIEnv()
  if (!supabase) throw new Error('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY is not configured')
  if (!openai) throw new Error('OPENAI_API_KEY is not configured')

  const embedding = await fetchOpenAIEmbedding(openai, query)
  const rpcUrl = `${supabase.url}/rest/v1/rpc/match_support_documents`
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${supabase.key}`,
      apikey: supabase.key,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify({ query_embedding: embedding, match_count: limit }),
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`Supabase vector search failed (${response.status}) ${detail.slice(0, 300)}`)
  }

  const rows = (await response.json()) as Array<Record<string, unknown>>
  return rows.map((row) => ({
    id: String(row.id ?? ''),
    title: String(row.title ?? 'Document'),
    excerpt: String(row.excerpt ?? String(row.content ?? '').slice(0, 280)),
    content: String(row.content ?? ''),
    source: row.source ? String(row.source) : undefined,
  }))
}

// Words too common to be useful signal in keyword retrieval.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'of', 'to', 'in', 'on', 'for', 'with', 'my',
  'your', 'our', 'you', 'we', 'it', 'is', 'are', 'am', 'do', 'does', 'did', 'how', 'what', 'where',
  'when', 'why', 'who', 'which', 'can', 'could', 'would', 'should', 'will', 'shall', 'may', 'might',
  'please', 'me', 'about', 'from', 'at', 'this', 'that', 'these', 'those', 'be', 'been', 'being',
  'have', 'has', 'had', 'get', 'got', 'need', 'want', 'there', 'here',
])

function tokenize(text: string): string[] {
  return (text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t))
}

/**
 * Keyword retrieval over the Supabase `support_documents` table — a
 * no-embeddings emulation of vector search. Fetches the (small) document set
 * and ranks by token overlap (title weighted highest). Used when vector search
 * is unavailable (e.g. no OpenAI quota for embeddings). Throws on a Supabase
 * error so the caller can fall through.
 */
async function keywordSearchSupportDocuments(query: string, limit = 4): Promise<SupportDocument[]> {
  const supabase = readSupabaseEnv()
  if (!supabase) return []
  const tokens = tokenize(query)
  if (!tokens.length) return []

  const url = `${supabase.url}/rest/v1/support_documents?select=id,title,excerpt,content,source&limit=500`
  const res = await fetch(url, {
    headers: { apikey: supabase.key, Authorization: `Bearer ${supabase.key}` },
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`Supabase keyword fetch failed (${res.status}) ${detail.slice(0, 200)}`)
  }
  const rows = (await res.json()) as Array<Record<string, unknown>>

  const scored = rows
    .map((row) => {
      const title = String(row.title ?? '')
      const excerpt = String(row.excerpt ?? '')
      const content = String(row.content ?? '')
      const titleTokens = new Set(tokenize(title))
      const bodyTokens = new Set(tokenize(`${excerpt} ${content}`))
      let score = 0
      for (const t of tokens) {
        if (titleTokens.has(t)) score += 3 // a title hit is a strong signal
        if (bodyTokens.has(t)) score += 1
      }
      return {
        score,
        doc: {
          id: String(row.id ?? ''),
          title,
          excerpt: excerpt || content.slice(0, 280),
          content,
          source: row.source ? String(row.source) : undefined,
        } as SupportDocument,
      }
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)

  return scored.slice(0, limit).map((s) => s.doc)
}

/**
 * Extractive "local RAG" generation — build an answer from retrieved documents
 * WITHOUT an LLM. Used when OpenAI generation is unavailable (no key / no
 * quota). Returns the most relevant document's content, trimmed at a sentence
 * boundary, so the user gets the real knowledge-base answer instead of a canned
 * "no match". The retrieved documents are still returned as `sources`.
 */
function localRagAnswer(docs: SupportDocument[]): string {
  const top = docs[0]
  if (!top) return ''
  const body = (top.content || top.excerpt || '').trim()
  if (!body) return ''
  if (body.length <= 700) return body
  const clipped = body.slice(0, 700)
  const lastStop = Math.max(clipped.lastIndexOf('. '), clipped.lastIndexOf('\n'), clipped.lastIndexOf('! '))
  return `${(lastStop > 250 ? clipped.slice(0, lastStop + 1) : clipped).trim()} …`
}

async function createAssistantAnswer(
  query: string,
  docs: SupportDocument[],
  history: Array<{ role: 'user' | 'assistant'; content: string }> = [],
  lang: LangCode = 'en',
): Promise<string> {
  const openai = readOpenAIEnv()
  if (!openai) throw new Error('OPENAI_API_KEY is not configured')

  if (docs.length === 0) {
    return LOCALES[lang].noMatch
  }

  const documentPayload = docs
    .map((doc, index) => {
      return `Document ${index + 1}: ${doc.title}${doc.source ? ` (${doc.source})` : ''}\n${doc.content}`
    })
    .join('\n\n')

  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: buildSystemPrompt(LOCALES[lang].name) },
  ]

  for (const turn of history.slice(-10)) {
    messages.push({ role: turn.role, content: turn.content })
  }

  messages.push({
    role: 'user',
    content: `Use the documents below to answer the question. If the answer is not contained in the documents, say the exact information is unavailable and offer to log a support request so the right team can follow up.\n\nDocuments:\n${documentPayload}\n\nQuestion: ${query}`,
  })

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${openai.key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: openai.model,
      messages,
      temperature: 0.2,
      max_tokens: 512,
    }),
  })

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`OpenAI completion failed (${res.status}) ${detail.slice(0, 300)}`)
  }

  const completion = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>
  }
  return completion.choices?.[0]?.message?.content?.trim() || ''
}

export async function assistantRoutes(app: FastifyInstance): Promise<void> {
  app.post('/', async (req: FastifyRequest<{ Body: AssistantRequest }>, reply: FastifyReply) => {
    const message = String(req.body?.message ?? '').trim()
    if (!message) return reply.code(400).send({ error: 'Message is required.' })
    const lang = resolveLang(req.body?.language)

    // Retrieval + generation cascade with native-language translation. The
    // knowledge base is English, so a native question (Igbo/Yorùbá/Hausa) is
    // translated to English for retrieval, and the English answer is translated
    // back to the selected language for output (spoken or written):
    //   0. Translate query -> English (via deep_translator/Google)
    //   1. Early conversational fallback  — greeting / help intents
    //   2. Retrieval: Supabase vector  →  Supabase keyword (emulated vector)
    //   3. Generation: OpenAI LLM  →  local extractive RAG (from the excerpts)
    //      → translate the answer back to `lang`
    //   4. Generic fallback            — offer to log a request (already localized)

    // 0. Native question -> English for retrieval. English passes through.
    const englishQuery = lang === 'en' ? message : (await translateText(message, lang, 'en')).text
    if (lang !== 'en') {
      app.log.info(`Assistant: translated query [${lang}->en] "${englishQuery.slice(0, 80)}"`)
    }
    // Render a final English answer in the user's selected language.
    const toUserLang = async (englishText: string): Promise<string> =>
      lang === 'en' ? englishText : (await translateText(englishText, 'en', lang)).text

    // 1. Early conversational fallback for a BARE greeting or help intent, run
    // on the English query so native greetings/help are caught too.
    const greetingRe = /^(hi+|hello|hey+|hiya|yo|greetings|are you there|good\s+(?:morning|afternoon|evening))[\s!.,?]*$/i
    if (greetingRe.test(englishQuery)) {
      return reply.send({ answer: LOCALES[lang].greeting, sources: [], stage: 'conversational' })
    }
    const helpRe = /^(help|menu|options|what can you (do|help( me)?( with)?)|how (can|do) you help( me)?)[\s!.,?]*$/i
    if (helpRe.test(englishQuery)) {
      return reply.send({ answer: LOCALES[lang].help, sources: [], stage: 'conversational' })
    }

    const supabase = readSupabaseEnv()
    const openai = readOpenAIEnv()

    // 2. Retrieval (English query) — Supabase vector first, then keyword emulation.
    let docs: SupportDocument[] = []
    let retrieval = 'none'
    if (openai && supabase) {
      try {
        docs = await searchSupportDocuments(englishQuery, 4)
        if (docs.length) retrieval = 'supabase-vector'
      } catch (err) {
        app.log.warn(`Vector retrieval unavailable, trying keyword: ${(err as Error).message}`)
      }
    }
    if (!docs.length && supabase) {
      try {
        docs = await keywordSearchSupportDocuments(englishQuery, 4)
        if (docs.length) retrieval = 'supabase-keyword'
      } catch (err) {
        app.log.warn(`Keyword retrieval failed: ${(err as Error).message}`)
      }
    }

    const sources = docs.map((doc) => ({ title: doc.title, excerpt: doc.excerpt, source: doc.source }))

    // 3. Generation over the retrieved documents.
    if (docs.length) {
      // 3a. OpenAI LLM generation (best) — the model answers directly in `lang`.
      if (openai) {
        try {
          const answer = await createAssistantAnswer(englishQuery, docs, req.body?.history ?? [], lang)
          if (answer && answer.trim()) {
            app.log.info(`Assistant: openai generation over ${retrieval}`)
            return reply.send({ answer, sources, stage: `openai/${retrieval}` } as AssistantResponse)
          }
        } catch (err) {
          app.log.warn(`OpenAI generation failed, using local RAG: ${(err as Error).message}`)
        }
      }
      // 3b. Local extractive RAG — English excerpt, translated back to `lang`.
      const localEnglish = localRagAnswer(docs)
      if (localEnglish) {
        const answer = await toUserLang(localEnglish)
        app.log.info(`Assistant: local-rag generation over ${retrieval} [->${lang}]`)
        return reply.send({ answer, sources, stage: `local-rag/${retrieval}` } as AssistantResponse)
      }
    }

    // 4. Generic fallback — nothing matched; offer to log a request (localized).
    app.log.info('Assistant: generic fallback (no knowledge-base match)')
    return reply.send({ answer: LOCALES[lang].noMatch, sources: [], stage: 'generic' } as AssistantResponse)
  })

  // Text-to-speech: proxy the reply to the Python TTS engine (espeak-ng +
  // phonemizer + IPA lexicon) via src/tts.ts and return its audio (base64).
  // `fallback: true` means the server couldn't synthesize (engine down or a
  // Tier-3 unavailable language) — the client then uses browser speech
  // synthesis. `approx`/`warning` flag approximate (Tier-2) pronunciations.
  // Public, like the assistant route.
  app.post('/tts', async (req: FastifyRequest<{ Body: { text?: string; language?: string } }>, reply: FastifyReply) => {
    const text = String(req.body?.text ?? '').trim()
    if (!text) return reply.code(400).send({ error: 'Text is required.' })
    const result = await synthesizeSpeech(text, req.body?.language)
    return reply.send(result)
  })

  // Speech-to-text: transcribe a recorded voice clip with OpenAI (Whisper) via
  // src/stt.ts. More reliable than the browser's Web Speech API — cross-browser
  // and it handles Yorùbá/Hausa (and auto-detects Igbo). `fallback: true` means
  // the server couldn't transcribe (no key, timeout, API error, or no speech),
  // and the client should fall back to browser recognition or ask the user to
  // type. Public, like the assistant route. The clip arrives base64-encoded in
  // JSON to avoid a multipart dependency; the global 30MB body limit applies.
  app.post(
    '/stt',
    async (
      req: FastifyRequest<{ Body: { audioBase64?: string; mime?: string; language?: string; partial?: boolean } }>,
      reply: FastifyReply,
    ) => {
      const audioBase64 = String(req.body?.audioBase64 ?? '')
      if (!audioBase64) return reply.code(400).send({ error: 'Audio is required.' })
      const partial = req.body?.partial === true
      const result = await transcribeAudio(
        audioBase64,
        req.body?.mime ? String(req.body.mime) : undefined,
        req.body?.language ? String(req.body.language) : undefined,
        partial,
      )
      // Log WHY a FINAL transcription couldn't run (e.g. OpenAI quota/429) so
      // operators can see it — partials are noisy and expected to be ungated.
      if (!partial && result.fallback && result.warning) {
        app.log.warn(`STT fallback: ${result.warning}`)
      }
      return reply.send(result)
    },
  )
}
