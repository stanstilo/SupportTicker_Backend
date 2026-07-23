import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { synthesizeSpeech } from '../tts'

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
const LOCALES: Record<LangCode, { name: string; greeting: string; noMatch: string }> = {
  en: {
    name: 'English',
    greeting: "Hello — I'm here and ready to help. How may I assist you today?",
    noMatch:
      "I couldn't find a matching answer in our knowledge base. I can help you log a support request so the right team can follow up.",
  },
  ig: {
    name: 'Igbo',
    greeting: 'Ndewo — anọ m ebe a ịnyere gị aka. Kedu ka m ga-esi nyere gị aka taa?',
    noMatch:
      'Ahụghị m azịza dabara na ntọala ihe ọmụma anyị. Enwere m ike inyere gị aka idebanye arịrịọ nkwado ka ndị otu kwesịrị ekwesị nyochaa ya.',
  },
  yo: {
    name: 'Yoruba',
    greeting: 'Pẹlẹ o — mo wà níbí láti ràn ọ́ lọ́wọ́. Báwo ni mo ṣe lè ràn ọ́ lọ́wọ́ lónìí?',
    noMatch:
      'Nkò rí ìdáhùn tó bá a mu nínú ibi ìpamọ́ ìmọ̀ wa. Mo lè ràn ọ́ lọ́wọ́ láti forúkọ ìbéèrè àtìlẹ́yìn sílẹ̀ kí ẹgbẹ́ tó yẹ lè tẹ̀lé e.',
  },
  ha: {
    name: 'Hausa',
    greeting: 'Sannu — ina nan don taimaka maka. Yaya zan iya taimaka maka yau?',
    noMatch:
      'Ban sami amsa mai dacewa a cikin ma’ajin ilimin mu ba. Zan iya taimaka maka shigar da buƙatar tallafi domin ƙungiyar da ta dace ta biyo baya.',
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

    // Quick canned greeting handling: respond immediately (in the selected
    // language) for a BARE salutation — the whole message is just a greeting —
    // without invoking embeddings / Supabase / OpenAI. Anchored to the full
    // string so a real question that merely starts with "hello"
    // (e.g. "hello how do I reset password") still goes through the search.
    const greetingRe = /^(hi+|hello|hey+|hiya|yo|greetings|are you there|good\s+(?:morning|afternoon|evening))[\s!.,?]*$/i
    if (greetingRe.test(message)) {
      return reply.send({ answer: LOCALES[lang].greeting, sources: [] })
    }

    // If the RAG backend isn't configured (no OpenAI key or no Supabase), degrade
    // gracefully to the localized fallback (which offers to log a request) with a
    // 200 instead of erroring — the chat widget stays usable without those keys.
    if (!readOpenAIEnv() || !readSupabaseEnv()) {
      app.log.info('Assistant not fully configured (OpenAI/Supabase) — returning fallback answer')
      return reply.send({ answer: LOCALES[lang].noMatch, sources: [] })
    }

    try {
      const docs = await searchSupportDocuments(message, 4)
      const answer = await createAssistantAnswer(message, docs, req.body?.history ?? [], lang)
      const sources = docs.map((doc) => ({ title: doc.title, excerpt: doc.excerpt, source: doc.source }))
      return reply.send({ answer, sources } as AssistantResponse)
    } catch (err) {
      app.log.warn(`Assistant request failed: ${(err as Error).message}`)
      return reply.code(502).send({ error: 'Assistant unavailable. Please try again later.' })
    }
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
}
