# Automatic ChatGPT Capture — Research & Recommendation

Status: Implemented 2026-11-02. The director uses ChatGPT Plus/Pro, so there is no Compliance API. Built: Layer 1
(automatic import of exports from the Downloads folder, plus a reminder) and Layer 2 (browser extension, off by default,
switched on in Settings with an explicit acknowledgement of the terms-of-service note). Layer 3 does not apply. The
extension has been tested only against a simulated ChatGPT page; §8 still needs checking on the real account.

---

## 1. Summary

1. **Fully automatic and permitted sync exists in only one case:** a **ChatGPT Enterprise** (or Edu) workspace with
   OpenAI's **Compliance API**. It gives workspace admins programmatic access to conversations, both old and new.
   On any other plan, no permitted method can automatically collect every conversation in the account.
2. **Capturing conversations as they happen in the browser** is technically achievable with a **browser extension**.
   It reads only the conversation the director has open, from the page itself. It cannot see conversations that are
   never opened, it does not see the ChatGPT desktop or mobile apps, and it depends on ChatGPT's page layout, which
   OpenAI can change without notice.
3. **There is a terms-of-service conflict that must be decided by the company, not by the developer.** OpenAI's
   Terms of Use (effective 1 January 2026) list among prohibited uses: *"Automatically or programmatically extract data
   or Output."* An extension that automatically copies ChatGPT replies falls within the plain wording of that clause,
   even though the data is the director's own. Business and Enterprise plans are governed by OpenAI's business terms
   instead. Those should be checked too, but for Enterprise the Compliance API makes the question moot.
4. **Older conversations that were never opened can only be reached through the official export** (any plan) or the
   Compliance API (Enterprise). The export step can be reduced to about two clicks a month: the app can watch the
   Downloads folder and import new exports by itself.

**Recommendation:** a layered design that uses the official routes for completeness and the extension only for
immediacy. The details are in §6.

## 2. Two different problems

| | **Live capture** (what the director is doing now) | **Historical backfill** (everything already in the account) |
|---|---|---|
| Goal | New and continued conversations appear in memory within seconds | Every past conversation, including ones not opened in months |
| Who triggers it | The director simply using ChatGPT | Nothing, unless the system can enumerate the account |
| Permitted routes | Compliance API (Enterprise); extension (with the ToS issue); in-chat connector (partial) | Official export (all plans); Compliance API (Enterprise); admin export (Business) |
| Hard limit | Only sees what is shown on screen | Enumerating the account without an official route requires the private API or automation, both excluded |

No browser-side technique can retrieve a conversation the user never opens without calling ChatGPT's internal
(undocumented) web API. That is exactly what the requirements forbid. **Complete automatic synchronization therefore
cannot be promised on a non-Enterprise account.**

## 3. Options evaluated

### 3.1 Browser extension: reads the open conversation from the page (DOM)

How it works: a Chrome/Edge extension with a content script on `chatgpt.com` watches the rendered conversation.
When a reply finishes streaming, it reads the visible messages and sends them to the local app over
`http://localhost`, authenticated with a pairing token.

| Aspect | Assessment |
|---|---|
| Workflow change | None, once installed |
| Captures | Messages of any conversation the director opens or writes in, in display order. The conversation id comes from the URL (`/c/<id>`), which is the same id used in the official export, so captures and exports merge without duplicates. The title comes from the page. |
| Does not capture | Conversations never opened. The desktop and mobile apps, other browsers, other devices. Alternative versions of edited or regenerated messages, unless the director switches to them on screen. |
| Timestamps | The page does not show per-message times, so the capture time is recorded and labelled as approximate. The next official export supplies the exact times. |
| Message ids | The page currently tags messages with ids and author roles in HTML attributes. They are expected to match the export's node ids, which would make deduplication exact, but this must be verified in a prototype on the real account. Otherwise matching falls back to content hashing. |
| Reliability | Medium. It depends on ChatGPT's page structure, which changes. Mitigations: tolerant selectors, a health check that alerts when nothing has been captured during active use, and periodic exports that fill any gaps. |
| Security | Good if built carefully. No cookies or passwords are touched and the extension holds no ChatGPT credentials. It needs permission for `chatgpt.com` and `localhost` only, and sends data only to the local app. It is distributed privately (unpacked, or via company browser policy), not through a public store. |
| Constraints you set | Meets "no passwords, no cookies, no bypassing authentication". It does **not** call the private API. It does fall within the ToS clause in §1, point 3. |

*Rejected variant:* intercepting the page's network responses (patching `fetch` to read ChatGPT's internal JSON).
It would give exact timestamps and all branches, but it reads the undocumented private API, which the requirements
exclude.

### 3.2 Browser automation (Playwright/Selenium driving a logged-in browser)

It could open every old conversation and so in theory solve backfill. **Rejected:**
- It is programmatic extraction in the most literal sense.
- ChatGPT's bot protection detects it.
- It needs a reused session (cookies) or stored credentials, which you excluded.
- It breaks often.

### 3.3 Local background agent

| Variant | Verdict |
|---|---|
| Network proxy that decrypts HTTPS traffic (installs a root certificate) | **Rejected.** It reads the private API, weakens the machine's security, and is fragile. |
| Reading the browser's on-disk cache or storage for chatgpt.com | **Rejected.** It touches session data, is unreliable, and is unsupported. |
| Screen recording or OCR of the desktop app | **Rejected.** It is inaccurate, intrusive and has no ids. |
| **Watched-folder importer for official exports** | **Recommended.** It is fully permitted. A small agent, or the app itself, watches the Downloads folder for a new ChatGPT export ZIP and imports it with the existing Phase 1 importer. Manual work drops to: Settings → Export data, then clicking the link in OpenAI's email. |

### 3.4 Official OpenAI integrations

| Route | Plan | What it gives | Verdict |
|---|---|---|---|
| **Enterprise Compliance API** | Enterprise, Edu (and Healthcare) | Admin, programmatic access to workspace conversations, old and new. OpenAI: *"workspace admins can access an audit log of conversations and GPTs through the Enterprise Compliance API."* | **Best possible solution**: automatic, complete within the retention period, permitted, exact ids and timestamps. It needs an Enterprise contract. Third-party sources say the API moved to a new "conversation logs" endpoint in mid-2026, so the exact endpoint must be confirmed against OpenAI's documentation at build time. |
| Business admin export | Business | OpenAI: admins *"can view, access, export, and delete end user conversations."* | Permitted, but per the sources found it is admin-console export, not an API. It works like the personal export. |
| Personal "Export data" | All plans | Complete history ZIP (what Phase 1 imports) | Permitted and complete, but manual: emailed link, valid for 24 hours. |
| **Custom MCP connector / ChatGPT app** (developer mode) | Plan-dependent; sources conflict on whether Plus/Pro get write actions or only Business and above | ChatGPT can call tools on our server: `search_memory` (ChatGPT answers using the director's history) and `save_to_memory` (ChatGPT stores a summary when asked) | Permitted and valuable for **retrieval inside ChatGPT**. It is **not** a capture method: it only receives what the model chooses to send (summaries, not verbatim transcripts), needs to be invoked, and requires our server to be reachable from the internet with OAuth. |

### 3.5 Other: an in-house chat front-end

If the company ran its own chat interface on the OpenAI or Anthropic API, every conversation would be captured
natively, completely and with full permission. That changes the director's workflow, so it is listed only as an
option for the future.

## 4. Comparison

| | Automatic | Covers old history | Accuracy (ids, timestamps, branches) | Permitted | Maintenance | Workflow change |
|---|---|---|---|---|---|---|
| Enterprise Compliance API | ✅ Full | ✅ (within retention) | ✅ Exact | ✅ | Low | None |
| Official export + watched folder | ⚠️ About 2 clicks a month | ✅ Complete | ✅ Exact | ✅ | Very low | Minimal |
| Browser extension (page reading) | ✅ For opened conversations in the browser | ❌ | ⚠️ Visible branch only, approximate times | ⚠️ ToS clause | Medium | None |
| MCP connector in ChatGPT | ❌ (on request) | ❌ | ⚠️ Summaries | ✅ | Low | Small |
| Browser automation | ✅ | ✅ | ✅ | ❌ | High | None |
| Network interception / private API | ✅ | ✅ | ✅ | ❌ (excluded) | High | None |

## 5. What "complete" can honestly mean

| Plan | Best achievable |
|---|---|
| **Enterprise / Edu** | Fully automatic and complete (Compliance API), subject to the workspace's retention settings. |
| **Plus / Pro / Business** | Conversations the director opens in the browser are captured within seconds (extension, if approved). Everything else is captured at the next export, which the app imports by itself once it reaches the Downloads folder. Gaps are possible between exports for conversations used only on the phone or desktop app. |

The app will show this openly: each conversation and message carries its origin (*official export*, *Compliance API*
or *live capture*) and a "last confirmed by export" date. Answers can then say when information comes from an
unconfirmed live capture.

## 6. Recommended design

```
 ChatGPT (browser) ──► Extension ──localhost + token──► /api/capture ─┐
                                                                       │   staging (raw capture, origin=live)
 OpenAI export email ─► Downloads ─► Folder watcher ─► importer ───────┤──► conversations / messages
                                                                       │   (export = authoritative; reconciles live)
 Enterprise only: Compliance API poller (every N min) ─────────────────┘
                                   │
                                   ▼
         Background pipeline: chunk → index → (Phase 3) extract decisions/tasks → link projects
```

**Layer 1: Historical backfill and safety net (do first, no risk).** One full export now. Then a folder watcher that
auto-imports any new ChatGPT export ZIP, plus a reminder on the dashboard when the last export is more than N days old.

**Layer 2: Live capture (only if the company accepts the ToS position in §7).**
- A Manifest V3 extension for Chrome/Edge, paired with the local app by a one-time token.
- Captures are stored as `origin = live_capture` and merged by conversation id.
- When the next export arrives it is authoritative: it fills in exact timestamps and branches, and confirms or
  corrects live-captured messages. Nothing is duplicated, and differences are reported.

**Layer 3: Compliance API connector (if or when on Enterprise).** It replaces layers 1 and 2 for automatic collection.

**Optional:** an MCP connector so the director can ask ChatGPT itself, mid-conversation, to "check my memory".

**Changes to the existing Phase 1 app (it remains the foundation):**
- `messages.origin`, `messages.captured_at`, `conversations.last_confirmed_by_export_at`.
- A `/api/capture` endpoint (accepts localhost only, token-authenticated, rate-limited).
- A capture-health panel on the dashboard.
- The reconciliation logic is extended to merge live captures with exports.
- Search and the reader work unchanged. Live-captured messages show a "not yet confirmed by export" badge.

**Automatic understanding (requirements 3 and 4):** extracting decisions, requirements and tasks, recognising
projects and linking related conversations is the **knowledge layer (Phase 3 in ARCHITECTURE.md), which is not built
yet**. The capture layers above feed it automatically once it exists. Phase 1 today already makes captured content
searchable without any manual step. It does not yet include document generation or AI question answering; those are
Phases 2 and 4.

## 7. Decisions needed

1. **Which ChatGPT plan does the director use?** If it is Enterprise, or the company would move to it, build the
   Compliance API connector and skip the extension entirely.
2. **Accept or decline the extension's terms-of-service risk.** It reads the director's own conversations from the
   page, but OpenAI's Terms prohibit automatic extraction of Output. This is a legal and business call. The developer
   should not make it alone.
3. **Approve Layer 1 now.** It is permitted, low-effort, and reduces export imports to about two clicks a month.

## 8. Verification still required

- That message ids on the page match the export's node ids. This needs a prototype run on the real account; I cannot
  sign in to the director's ChatGPT.
- The current Compliance API endpoint, scopes and retention for the director's workspace (only if Enterprise).
- Whether custom-connector write actions are available on the director's plan (only if the MCP option is wanted).

## Sources

- OpenAI Terms of Use, effective 1 Jan 2026: https://openai.com/policies/row-terms-of-use/ (read directly)
- OpenAI Enterprise privacy, updated 8 Jan 2026: https://openai.com/enterprise-privacy/ (read directly)
- Compliance API availability and endpoint changes (secondary sources):
  https://www.worklytics.co/blog/how-to-export-analyze-chatgpt-enterprise-usage-data ·
  https://docs.revealdata.com/onna/docs/chatgpt-how-to-connect-and-collect ·
  https://www.buildmvpfast.com/blog/openai-enterprise-compliance-audit-logs-dashboard-2026
- Custom MCP connectors in ChatGPT (secondary, partly conflicting):
  https://help.boomi.com/docs/Atomsphere/Platform/Connect_chatgpt_setup ·
  https://www.infoq.com/news/2025/10/chat-gpt-mcp · https://auth0.com/blog/add-remote-mcp-server-chatgpt/
