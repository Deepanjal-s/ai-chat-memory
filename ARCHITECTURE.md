# AI Memory & Conversation Intelligence Platform — Architecture Proposal

Status: Proposal v1 (2026-11-02). **Implemented**, with these changes from the proposal:
- **Stack:** TypeScript/Next.js instead of Python/FastAPI. Embedded PGlite for a single PC, PostgreSQL + pgvector on a
  server.
- **Collection:** ChatGPT exports plus a capture extension; see CAPTURE_RESEARCH.md.
- **No AI by default:** the AI provider is optional (rule-based extraction and record-only answers when off).
- **Not built yet:** the MCP server (§10.3).

See README.md for what exists and its limitations.

---

## 1. What the requirements really demand

Reading the ten requirement chunks together, the system is four things stacked on each other:

| Layer | Requirement chunks | Core question it answers |
|---|---|---|
| **Archive** | 2, 9 | "Do we have every message, exactly as it was, with no duplicates?" |
| **Retrieval** | 4, 6 | "Which passages in which conversations are relevant to this question?" |
| **Knowledge** | 3, 5 | "What projects, decisions, requirements, tasks exist, and how did they change over time?" |
| **Products** | 6, 7, 8, 10 | Q&A with citations, documents, dashboard, memory for new tasks |

The hard, non-negotiable constraint running through all of them is **traceability**: every
answer, extracted fact, and document sentence must point back to a specific message in a
specific conversation, and that message must exist unmodified in the archive. The architecture
below is built around that constraint rather than around a chatbot.

## 2. The ChatGPT data access reality (important)

- **ChatGPT has no official API for reading a user's conversation history.** The OpenAI API
  is a separate product and cannot see chatgpt.com conversations.
- The **supported, reliable route is the official data export**: ChatGPT → Settings → Data
  Controls → *Export data*. OpenAI emails a ZIP containing `conversations.json` (plus
  `chat.html`, uploaded files, images, etc.).
- Scraping chatgpt.com's private web API or automating the browser would break whenever the
  site changes and conflicts with OpenAI's terms. It is not suitable for a system the company
  relies on.

**Decision:** Import is export-based. "Sync" means: the director (or an assistant) requests a
fresh export periodically (e.g. monthly) and drops the ZIP into the app; the importer merges
only what is new or changed. A watched-folder option and, later, an optional browser extension
that captures new conversations as they happen can reduce the manual step.

### Export format facts the importer must handle

- Each conversation has `id`, `title`, `create_time`, `update_time`, and a `mapping` — a
  **tree** of message nodes (`parent` / `children`), not a flat list.
- The tree has **branches**: every time a message was edited or a reply regenerated, a sibling
  branch is created. `current_node` marks the leaf of the branch the user last saw.
- Nodes include system/tool messages, hidden nodes, multimodal parts (images, files, code
  execution output), and model metadata.

The importer stores **all nodes**, and marks the `current_node` path as the canonical thread.
Abandoned branches are kept (they can contain earlier versions of a requirement) but are
retrieved with lower weight and labeled as "edited/regenerated branch".

## 3. High-level architecture

```
                ┌──────────────────────────────────────────────────────────┐
                │                 Web App (Next.js / React)                │
                │ Dashboard · Conversations · Search · Ask · Projects ·    │
                │ Timeline · Decisions · Tasks · Documents · Import · Admin│
                └───────────────▲──────────────────────────▲───────────────┘
                                │ HTTPS (SSO + MFA)        │
                ┌───────────────┴──────────────────────────┴───────────────┐
                │                    API (Python / FastAPI)                │
                │  Query planner · Hybrid retriever · Answer engine ·      │
                │  Citation verifier · Doc generator · Memory service      │
                └──────┬──────────────┬───────────────┬────────────┬───────┘
                       │              │               │            │
           ┌───────────▼───┐  ┌───────▼───────┐ ┌─────▼─────┐ ┌────▼─────────────┐
           │ PostgreSQL 17 │  │ Object storage│ │ Job queue │ │  MCP server      │
           │ + pgvector    │  │ (raw exports, │ │ + workers │ │  (memory access  │
           │ + full-text   │  │  attachments, │ │ (ingest,  │ │  for Claude /    │
           │ (single source│  │  generated    │ │  embed,   │ │  other AI tools) │
           │  of truth)    │  │  documents)   │ │  extract) │ └──────────────────┘
           └───────────────┘  └───────────────┘ └─────┬─────┘
                                                      │
                                     ┌────────────────▼─────────────────┐
                                     │ Model providers (pluggable)      │
                                     │ LLM: Claude API (ZDR) or local   │
                                     │ Embeddings: Voyage / local bge-m3│
                                     │ Reranker: Voyage / local bge     │
                                     └──────────────────────────────────┘
```

### Technology choices and why

| Concern | Choice | Reasoning | Alternatives considered |
|---|---|---|---|
| Backend | **Python 3.12 + FastAPI** | Best ecosystem for parsing, NLP, embeddings, DOCX/PDF generation | Node/NestJS (weaker ML ecosystem) |
| Primary DB | **PostgreSQL 17 + pgvector** | One transactional store for raw data, knowledge graph, vectors *and* full-text. Data integrity (FKs, constraints, transactions) matters more than vector-DB niche features at this scale | Qdrant/Weaviate + Postgres (two stores to keep consistent); Neo4j (graph is modest, Postgres handles it) |
| Keyword search | Postgres full-text (`tsvector`) for candidates, **BM25 re-ranking in `src/lib/bm25.ts`** (ParadeDB `pg_search` is the server-side alternative) | Exact names like "VK7SPORTS", error codes, and IDs are poorly served by embeddings alone | Elasticsearch/OpenSearch (another cluster to run) |
| Raw storage | **S3-compatible object store** (MinIO self-hosted, or S3/Azure Blob) | Immutable original ZIPs, checksummed | Filesystem (fine for v1 single server) |
| Jobs | **Postgres-backed queue** (Procrastinate) or Redis + Arq | Long imports, embedding, extraction run in the background with retries and progress | Celery (heavier) |
| LLM | **Claude** — Sonnet 5.5 for answers/docs, Haiku 5.5 for bulk extraction, Opus 5.5 for hard synthesis; via a provider interface | Strong long-context reasoning and native citation support; Batch API for cheap bulk extraction | Local models (Llama/Qwen) for full air-gap, at a quality cost |
| Embeddings | **Voyage** (`voyage-3.5` family) or local **bge-m3** | Pluggable; local option if the company forbids sending content to any third party | OpenAI embeddings |
| Reranking | Voyage rerank or local **bge-reranker-v2** | Reranking is the single biggest precision gain in RAG | LLM-as-reranker (slow, costly) |
| Frontend | **Next.js + TypeScript + Tailwind + shadcn/ui** | Professional, fast to build, easy for non-technical users | — |
| Documents | **python-docx** (DOCX), HTML → **WeasyPrint** (PDF), Markdown | Full control over layout, footnotes, and source appendix | Pandoc |
| Auth | **OIDC SSO** (Microsoft Entra / Google Workspace) + MFA; local fallback | Company-grade access control | — |
| Deployment | **Docker Compose** on a company-controlled server / private cloud VM | Simple to operate; confidential data stays in the company's tenancy | Kubernetes (unnecessary for one user/team) |

**Scale check:** 5,000 conversations × ~40 messages ≈ 200k messages ≈ 300–500k chunks. This is
comfortably within a single Postgres instance with HNSW vector indexes (sub-100 ms queries). No
distributed infrastructure is needed; the design leaves room to split out later.

## 4. Data model (core tables)

```
sources            (id, type='chatgpt_export', account_label, …)          -- future: claude, gemini, slack, email
import_batches     (id, source_id, file_sha256, object_key, uploaded_at, status, stats_json)
conversations      (id, source_id, external_id, title, created_at, updated_at,
                    current_node_id, content_hash, first_seen_batch, last_seen_batch, is_archived)
conversation_versions (conversation_id, batch_id, content_hash, raw_json)  -- full raw JSON per version, never overwritten
messages           (id, conversation_id, external_node_id, parent_id, role, author_meta,
                    created_at, content_text, content_parts_json, model_slug,
                    is_canonical_path, branch_index, position, content_hash)
attachments        (id, message_id, kind, object_key, mime, extracted_text)
chunks             (id, conversation_id, message_ids[], text, context_header,
                    embedding vector, tsv tsvector, token_count)

-- Knowledge layer (every row is traceable)
entities           (id, kind[project|person|org|product|technology|topic], canonical_name, aliases[], description)
knowledge_items    (id, kind[decision|requirement|idea|task|problem|solution|preference|
                         instruction|deadline|plan|change|fact],
                    status[confirmed|proposed|assumption|discussed|rejected|superseded|done|open],
                    statement, details, effective_at, due_at,
                    confidence, extractor_version, review_state[auto|verified|rejected])
evidence           (knowledge_item_id, message_id, quote, char_start, char_end)   -- REQUIRED, ≥1 per item
item_entities      (knowledge_item_id, entity_id, role)
item_relations     (from_item, to_item, type[supersedes|contradicts|refines|resolves|depends_on])
conversation_entities (conversation_id, entity_id, salience)

-- Products
qa_sessions / qa_turns (question, answer, citations_json, retrieval_trace_json)
documents          (id, title, type, request, outline_json, object_keys, sources_json, created_at)
audit_log          (who, action, target, at)
```

Key integrity rules enforced in the schema:

- `UNIQUE(source_id, external_id)` on conversations and `UNIQUE(conversation_id, external_node_id)`
  on messages → **re-imports can never duplicate**.
- Raw JSON is append-only per version → **the original can always be verified**.
- A knowledge item without an `evidence` row is rejected at write time → **no unsupported facts
  enter the knowledge base**.

## 5. Pipeline 1 — Import & integrity

1. **Upload** ZIP → store immutably, record SHA-256. Re-uploading the same file is a no-op.
2. **Parse** `conversations.json` with a streaming parser (exports can be hundreds of MB).
3. **For each conversation:** compute a content hash of the normalized mapping.
   - New `external_id` → insert.
   - Same hash → skip (record `last_seen_batch`).
   - Changed hash → store a new `conversation_version`, upsert messages by node id (new
     messages added, existing ones untouched unless content differs, in which case both versions
     are kept), and flag the conversation for re-chunking and re-extraction.
   - Conversation missing from a newer export → mark `possibly_deleted_in_source`, **never
     delete** locally.
4. **Linearize** the tree: walk from `current_node` to root for the canonical path; record
   branches separately.
5. **Reconciliation report** per import: conversations/messages found in file vs. stored,
   new/updated/unchanged/skipped counts, and any parse errors with the offending IDs. An import
   is only marked `complete` when file counts equal stored counts. This is shown in the UI.

## 6. Pipeline 2 — Indexing (retrieval units)

- **Chunking** respects message boundaries: a chunk is one message, or a window of consecutive
  turns (user question + assistant answer kept together), split further only for very long
  messages (~800 tokens, with overlap). Code blocks are never split mid-block.
- Each chunk gets a **context header** prepended before embedding:
  `Conversation: "<title>" · <date> · Project(s): <entities> · Turn 12 of 40`. This
  "contextual retrieval" technique materially improves recall for short or ambiguous messages.
- Both **dense embedding** and **BM25/full-text** index are stored for every chunk.

## 7. Pipeline 3 — Knowledge extraction (the "understanding" layer)

Runs per conversation (Batch API for the initial backfill, live for incremental imports).

1. **Conversation summary** (short + detailed) and a list of topics.
2. **Structured extraction** with a strict JSON schema: knowledge items of the kinds listed in
   §4, each with a *status* (confirmed decision vs. suggestion vs. assumption vs. mere discussion)
   and **verbatim evidence quotes with message IDs**.
3. **Evidence verification (deterministic, not AI):** every quote is string-matched (normalized
   whitespace) against the cited message. Items whose quotes do not appear in the source are
   discarded and logged. This is the main defense against hallucinated "memory".
4. **Status rules:** the prompt and a post-check enforce that "the assistant suggested X" is
   `proposed`, not `confirmed`. Only explicit user acceptance ("yes, let's go with X", "final:
   …") yields `confirmed`. Ambiguous cases default to the weaker status.
5. **Entity resolution:** mentions ("VK7SPORTS", "VK7 Sports", "the sports app") are linked to
   canonical entities via alias tables + embedding similarity + an LLM adjudication step for
   close calls. Uncertain merges go to a **review queue** in the UI rather than being merged
   silently — mixing projects is listed as an explicit risk in chunk 9.
6. **Cross-conversation linking:** new items are compared to existing items about the same
   entity; an LLM judge proposes `supersedes` / `contradicts` / `refines` / `resolves`
   relations. This is what powers "what changed later?", conflict detection, and "don't present
   outdated information as current".
7. **Project profiles** are regenerated incrementally: overview, current state, confirmed
   decisions, open questions, pending tasks, timeline — each line linked to evidence.

All extractions carry `extractor_version`, so improved prompts can re-run over history without
losing earlier results.

## 8. Pipeline 4 — Question answering

```
question
  → Query planner (LLM): detect entities, time range, intent (lookup / list / timeline /
    summary / comparison), decompose into sub-queries
  → Retrieval, in parallel:
      a) knowledge_items filtered by entity/kind/time (structured)
      b) hybrid chunk search: BM25 + vector → Reciprocal Rank Fusion → reranker
      c) project profile for any detected project
  → Context assembly: dedupe, order chronologically, label each passage with
    [conversation title · date · message id · status · superseded?]
  → Answer generation (Claude, with source passages as citable search-result blocks)
      rules: answer only from sources; separate Confirmed / Proposed / Discussed;
      flag contradictions; prefer latest unless asked for history; say
      "not found in your history" when evidence is insufficient
  → Citation verifier: every cited span must exist in the referenced message;
    uncited factual sentences are flagged or removed
  → Response: answer + inline citations + "Sources" panel (click → opens the original
    conversation scrolled to the message)
```

The full retrieval trace is stored with each answer for audit and debugging.

## 9. Pipeline 5 — Document generation

1. User request → planner proposes a **document type and outline** (overview, requirements,
   decisions, timeline, problems & solutions, pending tasks, open questions…). User can edit
   the outline before generation.
2. Each section is generated **separately** with its own targeted retrieval (avoids the
   "one giant prompt" failure mode and keeps citations precise).
3. Output is an intermediate **structured document model** (JSON: sections, paragraphs,
   tables, footnote citations) — then rendered to **DOCX**, **PDF**, and **Markdown** from the
   same model, so formats never diverge.
4. Every document ends with a **Sources appendix** (conversation title, date, link to the
   in-app view and to `chatgpt.com/c/<id>`), and a **"Confidence & gaps"** section listing
   contradictions and missing information.
5. Generated documents are versioned and stored in the Documents library.

## 10. Persistent memory for new tasks (chunk 5)

Three complementary mechanisms:

1. **Memory profile** — a continuously maintained, evidence-linked set of: standing
   preferences and instructions (e.g. "prefers PostgreSQL", "always wants a cost section"),
   active projects with their current state, key people and organizations. The director can
   view, correct, pin, or delete entries.
2. **"New task" workspace in the app** — the director describes a new task ("prepare an
   architecture for project X"); the system retrieves relevant projects, prior decisions, and
   preferences, shows them as a reviewable **context brief**, and then assists with the task
   grounded in that brief.
3. **MCP server** — exposes `search_memory`, `get_project`, `get_decisions`, `get_preferences`,
   `get_conversation` as tools over the Model Context Protocol. Claude Desktop, Claude Code, and
   other MCP-capable assistants can then pull the director's history *inside the tools they
   already use*, which is the most practical way to "stop re-explaining background".

## 11. User interface (chunk 8)

| Screen | Purpose |
|---|---|
| **Dashboard** | Recent activity, active projects, open tasks, upcoming deadlines, recently changed decisions, import health |
| **Ask** | Chat-style Q&A with citations, filters (project, date range), "show how this evolved" toggle |
| **Search** | Hybrid search with facets (project, entity, kind, date, role), highlighted snippets |
| **Conversations** | Faithful reader of the original thread, including branches; linked projects & extracted items in a side panel |
| **Projects** | Per-project profile: overview, requirements, decisions, tasks, problems, timeline, related conversations |
| **Timeline** | Chronological view of decisions and changes, filterable by project |
| **Decisions / Tasks** | Registers with status; director can mark tasks done or decisions verified |
| **Documents** | Generate (guided), library of past documents, re-generate with latest data |
| **Review queue** | Uncertain entity merges, contradictions, low-confidence items to confirm |
| **Import & Sync** | Upload export, progress, reconciliation reports, history |
| **Settings / Admin** | Users, SSO, model provider, data retention, audit log, backups |

Design principle: every AI-produced statement shows a small source chip; nothing is presented
without a way to click through to the original message.

## 12. Accuracy safeguards (chunk 9) — summary

| Risk named in requirements | Safeguard |
|---|---|
| Losing messages during import | Node-level storage, reconciliation counts, append-only raw JSON |
| Duplicating conversations | Unique keys on external IDs + content hashes; idempotent imports |
| Mixing unrelated projects | Entity resolution with review queue; retrieval filters by entity |
| Suggestions treated as decisions | Explicit status field, conservative defaulting, UI labels |
| Outdated info presented as current | `supersedes` relations, recency-aware ranking, "superseded" badges |
| Unsupported facts | Mandatory evidence quotes verified by string match; citation verifier on answers |
| Ignoring older context | Hybrid retrieval + entity-based structured retrieval (not just top-k similarity) |
| Uncertainty not communicated | Answers and documents include explicit "conflicts / gaps" sections |

**Evaluation harness:** a golden set of ~100 real questions with expected source conversations
(built with the director). Tracked per release: retrieval recall@10, citation precision,
unsupported-claim rate, and status-classification accuracy. Changes to prompts or models must
not regress these numbers.

## 13. Security & privacy

- **Deployment in the company's own environment** (on-prem server or private cloud VM); data
  never leaves except to the chosen model provider.
- **Model provider data handling:** use the Claude API under commercial terms (API data is not
  used for training) and request **zero-data-retention**; or switch the provider interface to
  self-hosted models for full isolation.
- Encryption in transit (TLS) and at rest (encrypted volumes, encrypted backups).
- SSO + MFA, role-based access (owner / assistant / viewer), per-project visibility later.
- Full **audit log** of logins, searches, exports, and document downloads.
- Optional **secrets scrubbing** at import (API keys, passwords pasted into chats are detected
  and masked in the searchable index, while the raw archive stays intact and access-restricted).
- Automated encrypted backups with tested restore.

## 14. Extensibility (chunk 10)

A `SourceConnector` interface (`parse() → conversations + messages + metadata`) makes ChatGPT
one connector among many. Planned next connectors: Claude exports, Gemini (Google Takeout),
meeting transcripts, email threads, Slack/Teams exports, uploaded documents. The knowledge layer
is source-agnostic.

## 15. Delivery plan

| Phase | Scope | Outcome |
|---|---|---|
| **1. Archive & search** | Docker stack, export importer with reconciliation, conversation reader, hybrid search, basic auth | Every conversation imported, browsable and searchable — verifiably complete |
| **2. Grounded Q&A** | Query planner, reranking, cited answers, citation verifier, "not found" behavior | Ask questions across all history with clickable sources |
| **3. Knowledge layer** | Extraction, evidence verification, entities & projects, supersession/conflicts, review queue, timeline | Project pages, decision & task registers, evolution over time |
| **4. Documents** | Outline → sectioned generation → DOCX/PDF/MD with source appendix | One-click reports, requirement docs, decision records |
| **5. Memory** | Memory profile, New-task workspace, MCP server | History used automatically in new work |
| **6. Hardening** | SSO/MFA, audit log, backups, eval harness in CI, performance tuning | Ready for everyday company use |

Phases 1–2 already deliver real value on their own; each later phase builds on the same data.

## 16. Decisions needed before building

1. **Model provider & privacy level** — Claude API with zero-data-retention (recommended:
   best accuracy), or fully self-hosted models (maximum isolation, lower quality, needs a GPU).
2. **Hosting** — company server / private cloud VM (recommended), or the director's own machine
   for a first pilot.
3. **A sample export** — a real (or sanitized) `conversations.json` to build and test the
   importer against the director's actual data shape and volume.
4. **Users** — director only, or also an assistant / team members (affects auth & permissions).
