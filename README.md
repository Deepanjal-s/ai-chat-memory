# Conversation Memory

A private, self-hosted external memory for a ChatGPT account. It collects the director's conversations, keeps the
originals unchanged, works out the projects, decisions, requirements and tasks in them, links discussions about the
same project across conversations, and answers questions and produces documents, always with references to the
original messages.

**To install it for the director, double-click `setup.cmd` and follow [GUIDE.md](GUIDE.md)**, which also explains
day-to-day use. Design documents: [ARCHITECTURE.md](ARCHITECTURE.md) (overall design) and
[CAPTURE_RESEARCH.md](CAPTURE_RESEARCH.md) (how conversations can and cannot be collected from ChatGPT).

---

## Measured retrieval quality

Search is benchmarked with [memory-recall-bench](https://github.com/Deepanjal-s/memory-recall-bench) on all 479 labelled
LongMemEval_s questions (`npx tsx scripts/bench-rankings.ts`): does the message that answers a question make it into a
4,000-token context?

| Keyword ranking | Any answer message | Evidence from every answer session |
|---|---|---|
| PostgreSQL `ts_rank_cd` (before) | 56% | 28% |
| **BM25 re-ranking (now)** | **85%** | **61%** |

163 questions that previously lost their evidence now keep it; 8 got worse.

**Semantic search on this computer** (`EMBEDDING_PROVIDER=local`, bge-small fused with BM25), measured on the two
question types where keyword search is weakest (all 30 preference questions and 30 random multi-session ones;
about 75 s per question on a laptop CPU, `--embed`):

| 4,000-token context | Keyword only | Keyword + local embeddings |
|---|---|---|
| Preference ("can you recommend…") | 60% | **77%** |
| Multi-session, evidence from every session | 30% | 30% |

Per question: 8 fixed, 3 broken (4k, all evidence). A real but modest gain, smaller than the benchmark's own
message-level retriever shows (47% → 80% on preference), most likely because the app embeds whole turns of up to
4,000 characters and bge-small only reads the first ~2,000. n = 60, so treat these as indicative.

## How conversations get in

| Source | What it covers | Effort | Notes |
|---|---|---|---|
| **Official ChatGPT export** (Settings → Data controls → Export data) | **Everything** in the account, with exact timestamps and every edited or regenerated version | About two clicks a month: request the export, then click the link in OpenAI's email. The app **imports the ZIP automatically** from your Downloads folder. | Authoritative. It corrects and confirms live captures. Upload on the Import page or via the command line also works. |
| **Browser extension** (Chrome/Edge, in `extension/`) | Conversations you open or continue in that browser, saved a few seconds after each reply | None once installed and paired | **Off by default.** Read the terms-of-service note under Settings first. It reads only the page on screen (no ChatGPT private API, cookies or passwords). It cannot see conversations you never open, or the desktop and phone apps. |

**There is no permitted way to collect every conversation in a Plus or Pro account automatically.** Only ChatGPT
Enterprise/Edu has an official API for that (the Compliance API). Complete history therefore always comes from
exports. The extension fills the gap between exports. See CAPTURE_RESEARCH.md.

## What the app does with them

- **Archive and integrity**
  - Every message node is stored, including edits and regenerations.
  - The original JSON of every export version, and every raw live capture, is kept append-only.
  - Imports are deduplicated by file fingerprint, conversation id and message id, and a reconciliation report checks
    the counts in the file against the counts stored.
  - Nothing is deleted when a conversation disappears from ChatGPT; it is flagged instead.
- **Understanding**, a background worker that runs automatically after each import or capture:
  - A summary of each conversation.
  - Projects, organisations, people, technologies and topics. "VK7 Sports", "vk7-sports" and "VK7SPORTS" resolve to
    one entity.
  - Decisions, requirements, tasks, problems, solutions, ideas, preferences and deadlines, each labelled
    confirmed / suggested / assumption / discussed / open / done.
  - **Every record must quote its source message word for word.** A plain text check (not AI) rejects anything whose
    quote is not actually in that message.
  - Records about the same project in different conversations are compared. A later statement that replaces an
    earlier one marks it **outdated**; statements that disagree are flagged as **conflicts**.
- **Search**: keyword search across every message, ranked with BM25 (rare, telling words count more than common ones; quotes for phrases, `-word` to exclude),
  with date, author and version filters. Optional semantic search, either on this computer (`EMBEDDING_PROVIDER=local`,
  free, nothing leaves the machine) or with Voyage AI, is fused with the keyword results.
- **Memory assistant** (Ask)
  - Answers only from the history, citing [S1], [S2]… which link to the exact message.
  - It separates confirmed decisions from suggestions, prefers current information over outdated, reports conflicts,
    and says so when the history does not contain the answer.
  - Citations to sources that do not exist are removed automatically.
  - A question that names a project only uses that project's conversations.
- **Documents**
  - Types: project report, technical documentation, decision record, requirements, pending tasks, timeline.
  - Formats: PDF, DOCX and Markdown, with a numbered source list linking back to each original conversation.
- **Pages**
  - Dashboard and Projects & topics, with a per-project page (timeline, decisions, tasks, requirements, changes, related
    projects).
  - Decisions & tasks register.
  - Conversation reader with summary, extracted records and related conversations.
  - Import & sync, Status (sources, background queue, failures with retry, data sent outside, backups) and Settings.

### With or without AI

| | `AI_PROVIDER=none` (default) | `AI_PROVIDER=gemini` (+ `GEMINI_API_KEY`) or `anthropic` (+ `ANTHROPIC_API_KEY`) |
|---|---|---|
| Where data goes | Nowhere: everything stays on the server | Conversation excerpts are sent to Google or Anthropic; each call is logged (Status → "Data sent outside") |
| Knowledge extraction | Conservative rules (explicit "Decision:", "we'll go with", "Pending:", "must"…) | The model reads each conversation, including implicit agreement ("sounds good, let's do that"). Quotes are still verified locally. |
| Change detection | Flags "may have changed" for human review; never marks anything outdated on its own | The model judges whether a later statement replaces or contradicts an earlier one |
| Ask | Shows the verified records grouped by status, plus the most relevant passages, all cited | A written answer that cites every statement |
| Documents | All sections are assembled from records | Adds an AI-written overview (citations verified) |

Default models: `gemini-3.5-flash` and `claude-opus-5-5`; override with `AI_MODEL`. Switching providers re-processes
conversations automatically, and the Status page also has "Re-process all".

**Gemini free tier:**
- Pro models have no quota and calls are slow at busy times. The app retries automatically, which suits background
  processing but makes answers on the Ask page slower.
- Google's terms allow content sent on the unpaid tier to be used to improve Google products and to be read by human
  reviewers. **Enable billing on the Google Cloud project before processing confidential conversations.**

---

## Run it on one PC (no Docker)

Requires Node.js 22+. The database is embedded (PGlite, a full PostgreSQL), so nothing else needs installing.

```bash
npm install
```

```bash
npm run hash-password -- "a long password of your choice"
```

Create `.env.local` from `.env.example`:

- Paste the `APP_PASSWORD_HASH=…` line from the previous step.
- Set `SESSION_SECRET` to a random string of 64 characters.
- **Set `DATA_DIR` to a folder that is not synced to OneDrive.**

```bash
npm run build
```

```bash
npm run start
```

Open http://localhost:3000 and sign in.

**First import:** request the export in ChatGPT and download the ZIP. It is imported automatically from the Downloads
folder (or upload it on **Import & sync**).

**Very large exports:** stop the app first (the embedded database allows one process), then run:

```bash
npm run import -- "C:\path\to\export.zip"
```

## Browser extension (live capture)

1. In Chrome or Edge open `chrome://extensions` (Edge: `edge://extensions`), turn on **Developer mode**, click **Load
   unpacked**, and choose the project's `extension` folder.
2. In the app, open **Settings**, read the note, and turn **live capture on**.
3. Under **Connected browsers**, create a pairing token. In the extension's settings page, enter the app address
   (`http://localhost:3000`) and the token, then click **Test connection**.
4. Use ChatGPT normally. The toolbar icon shows a count while captures are waiting and `!` when something needs
   attention. Captures are queued in the browser and retried every minute, so nothing is lost while the app is off.
   Status → Live capture shows what arrived.

For company-wide use, the extension can be force-installed through browser policy (Chrome
`ExtensionInstallForcelist`, from a packed `.crx` or a private Web Store listing). The app must then be reachable over
**https**.

## Server deployment (Docker)

`docker-compose.yml` runs PostgreSQL 17 with pgvector, plus the app.

1. Copy `.env.example` to `.env` and fill in `APP_PASSWORD_HASH`, `SESSION_SECRET` and `POSTGRES_PASSWORD`.
2. Run `docker compose up -d --build`.
3. Put an HTTPS reverse proxy (Caddy or nginx) in front.

On a server, exports are dropped into the `/data/inbox` volume rather than a Downloads folder. Back up PostgreSQL with
`pg_dump` and the `appdata` volume (original exports, documents) with your usual tooling.

## Backups and recovery

- **Embedded database:** a snapshot is taken automatically every 24 hours into `BACKUP_DIR` (default
  `DATA_DIR/backups`), keeping the newest `BACKUP_KEEP`. Status → Backups has **Back up now**.
- **Restore:** stop the app, move `DATA_DIR/pglite` aside, then run:

  ```bash
  node -e "const {PGlite}=require('@electric-sql/pglite');const {vector}=require('@electric-sql/pglite-pgvector');const fs=require('fs');PGlite.create({dataDir:process.argv[2],loadDataDir:new Blob([fs.readFileSync(process.argv[1])]),extensions:{vector}}).then(p=>p.close())" "BACKUP.tar.gz" "DATA_DIR/pglite"
  ```

- **Original exports** in `DATA_DIR/raw` are read-only and never modified. Include that folder in your backups.
- **Restarts are safe:** imports and background jobs resume automatically, and failed jobs retry with backoff
  (Status lists failures with a Retry button).

## Security

- **Sign-in:** password stored as an scrypt hash, signed HttpOnly session cookie, login throttling.
- **Request checks:** cross-site request checks on every change, and strict security headers (CSP, frame denial,
  no referrer).
- **Extension tokens:** stored only as SHA-256 hashes, revocable, rate-limited. Captures are validated strictly and
  refused while live capture is off.
- **Audit log** of sign-ins, imports, captures settings, raw-data and document downloads.
- **Logs:** an application log in `DATA_DIR/logs` that never contains message text.
- **External services:** only the two optional providers above. Every call is recorded with its purpose and size, and
  shown on the Status page.

## Development

```bash
npm test
```

There are 49 tests:

- Importer, reconciliation and search.
- The Gemini provider (simulated API: retries, blocked and truncated responses, key kept out of URLs).
- Knowledge extraction, quote verification, entity resolution and change detection.
- Live-capture merging and export reconciliation.
- Question answering and project scoping.
- PDF, DOCX and Markdown output.
- Jobs and retries, the folder watcher and backup/restore.
- The extension's page reader and delivery queue, run against a **simulated** ChatGPT page.

Generate sample data with `npx tsx scripts/make-demo-export.ts demo.zip`.

| Path | Contents |
|---|---|
| `src/lib/importer/` | Export reading, normalisation, import + reconciliation, folder watcher |
| `src/lib/capture/` | Live-capture validation and merging |
| `src/lib/ai/llm.ts` | AI providers (Gemini, Claude): structured JSON output, retries, external-call log |
| `src/lib/knowledge/` | Extraction (rules / AI), quote verification, entities, change detection, queries |
| `src/lib/qa.ts`, `retrieval.ts`, `search.ts` | Retrieval, answering, citation checks |
| `src/lib/documents/` | Document model and PDF/DOCX/Markdown rendering |
| `src/lib/jobs.ts`, `pipeline.ts` | Durable background jobs |
| `extension/` | Chrome/Edge extension |

## Known limitations

- **No automatic sync of the whole account on Plus or Pro:** complete history needs periodic official exports.
- **The live-capture extension:**
  - It has been tested only against a simulated ChatGPT page, not the live site. Verify it on the real account (see
    CAPTURE_RESEARCH.md §8).
  - It depends on ChatGPT's page layout, which OpenAI can change at any time.
  - It records capture time, not the exact message time, until the next export arrives.
- **AI mode was tested live with Gemini (`gemini-3.5-flash`) on the sample data only.** The Claude provider is covered
  only by tests with a simulated model (no key was available). Check answers on real data before relying on them.
- **Rule-based mode** only recognises explicitly worded decisions and tasks. Phrasing like "sounds good, do that"
  needs AI mode.
