# Conversation Memory — Install & User Guide

Part A is for whoever installs it (you or IT). Part B is for the director, day to day.

---

## Part A — Install and connect (about 20 minutes, once)

### What you need

- The director's **Windows PC** (the app runs on that PC; nothing is hosted on the internet).
- **Node.js 22 or newer**: install the "LTS" version from https://nodejs.org (all defaults).
- **Chrome or Edge**, only if you want live capture.
- Optional, for AI answers: a **Google Gemini API key** with **billing enabled**, or an **Anthropic API key with
  credit**.
  - Without a key, the app still works fully on the PC: built-in rules recognise decisions and tasks, and the assistant
    shows the verified records instead of a written answer.

### Step 1 — Install the app

1. Copy this whole folder to the director's PC, outside OneDrive. For example: `C:\ConversationMemory\app`.
2. Double-click **`setup.cmd`** and answer three questions:
   - **Data folder.** Press Enter for `C:\ConversationMemory\data`. Do not use a OneDrive folder.
   - **Password**, at least 10 characters. Only this password opens the app.
   - **Gemini API key.** Press Enter to skip.
3. Setup installs and builds the app. It then sets it to start automatically at Windows sign-in, adds a
   **Conversation Memory** shortcut to the desktop, and opens the app in the browser.
4. Sign in with the password.

> **Unattended install (IT):**
> `powershell -ExecutionPolicy Bypass -File setup.ps1 -DataDir C:\ConversationMemory\data -Password "<password>" [-GeminiKey <key>]`.
> Add `-NoAutostart`, `-NoShortcut` or `-NoStart` to skip those steps.

### Step 2 — Bring in the full ChatGPT history (official export)

1. In ChatGPT, open **Settings → Data controls → Export data → Export**.
2. OpenAI emails a download link, usually within minutes; the link expires after 24 hours.
3. Click the link to download the ZIP into the **Downloads** folder. **That's all.** The app detects it within 30
   seconds, imports it, and starts organising it.
4. Check progress on **Import & sync** in the app. Each import shows a "Reconciliation passed" check confirming every
   message was stored.

Repeat about once a month; the dashboard reminds you after 30 days. Re-importing never creates duplicates.

### Step 3 — Live capture in the browser (optional)

This saves each ChatGPT conversation a few seconds after each reply, so the memory stays current between exports.

**Read this first:**
- OpenAI's Terms of Use prohibit automatic extraction of data from ChatGPT. The company must decide whether to use this
  feature.
- It only sees conversations opened in this browser. The ChatGPT desktop and phone apps are not captured; monthly
  exports cover them.
- It has been tested against a simulated ChatGPT page. **Check it on the real account.**

To set it up:
1. In Chrome go to `chrome://extensions` (Edge: `edge://extensions`), switch on **Developer mode**, click **Load
   unpacked**, and select the app's **`extension`** folder.
2. In the app, open **Settings**, read the note, tick the box and click **Turn live capture on**.
3. Still in Settings, under **Connected browsers**, click **Create pairing token** and copy the token.
4. The extension's settings page opens automatically after installing (or right-click the extension icon →
   **Options**). Enter:
   - App address: `http://localhost:3000`
   - Pairing token: the token you copied

   Then click **Save** and **Test connection**. It should say "Connected. Live capture is ON".
5. Open any ChatGPT conversation and wait about 10 seconds. It appears under **Conversations** with a "Live capture"
   badge. The extension icon shows `!` if something needs attention.

### Step 4 — Turn on AI (optional)

1. Edit `.env.local` in the app folder (Notepad is fine):
   - Gemini: `AI_PROVIDER=gemini` and `GEMINI_API_KEY=<key>`
   - Claude: `AI_PROVIDER=anthropic` and `ANTHROPIC_API_KEY=<key>`
2. Restart: sign out of Windows and back in, or run `start-memory.cmd`. Existing conversations are re-processed
   automatically.

**Use a paid account for real data:**
- Google's **free** Gemini tier allows only a small number of requests per day. In testing it ran out after about 20
  conversations, and the rest waited until the next day.
- Google may also use content sent on the free tier to improve its products.
- Every call to an AI service is listed on the **Status** page.

### Keeping it healthy

| Task | How |
|---|---|
| **Backups** | Automatic, daily, in `<data folder>\backups` (last 7 kept). Also copy `<data folder>\raw` (the original exports) to your normal backup. Restore steps are in README.md. |
| **Update the app** | Replace the app folder's files (keep `.env.local`) and run `setup.cmd` again. It keeps the existing configuration. |
| **Problems** | **Status** shows failed background work (with **Retry**), capture errors and AI errors. Logs are in `<data folder>\logs` and `logs\server.log` in the app folder. |
| **Forgot the password** | Run `npm run hash-password -- "new password"` in the app folder, paste the result into `.env.local` (`APP_PASSWORD_HASH=…`), and restart. |
| **Disconnect a browser** | Settings → Connected browsers → **Revoke**. |

### Using it from more than one computer (optional)

The default install is private to one PC (`localhost`). For access from other devices or several people, run it on a
company server with Docker (see README → Server deployment). Then:
- Put it behind HTTPS (for example Caddy or nginx).
- Point the extension at the `https://` address.
- Drop exports into the server's `/data/inbox` folder.

---

## Part B — Using Conversation Memory (for the director)

Open it from the desktop shortcut (it runs at `http://localhost:3000`) and sign in.

| Page | What it's for |
|---|---|
| **Dashboard** | Latest confirmed decisions, open tasks, recognised projects, and a reminder when a fresh export is due. Type a question in the box at the top. |
| **Ask memory** | Ask in plain English, for example:<br>• "What did we decide about the VK7SPORTS backend?"<br>• "What are the pending tasks?"<br>• "What changed in the requirements over the last six months?"<br>Every statement ends with a reference like **[S3]**; click it to open the exact original message. Answers distinguish **confirmed** decisions from **suggestions**, and mark **outdated** and **conflicting** information. If your history doesn't contain the answer, it says so. |
| **Search** | Find exact words or names across all conversations. Use quotes for phrases, and `-word` to exclude a word. Filters: dates, who said it, and edited versions. |
| **Projects & topics** | Every project, company, person and technology found in your chats. A project page shows its timeline, decisions, requirements, open tasks, problems, and what changed over time. |
| **Decisions & tasks** | One list of every decision, task, requirement, problem and idea, newest first, each linked to its source. |
| **Conversations** | Read any past conversation exactly as it was, including earlier edited versions, with a summary, extracted points and related conversations alongside. |
| **Documents** | Create a project report, technical document, decision record, requirements document, pending-task report or timeline as **PDF, Word or Markdown**. Pick a project (or type a subject), choose the type, click **Generate**, and download when ready. Every point is numbered and listed under "Sources". |
| **Import & sync** | Drop an export here manually if you ever need to, and see the import history. |
| **Status** | Whether everything is up to date, plus any problems. |

**Labels you will see:**
- **Confirmed**: you decided it.
- **Suggested (not confirmed)**: ChatGPT proposed it and you didn't confirm it.
- **Outdated**: a later conversation replaced it.
- **May have changed**: a later statement looks different; worth a check.
- **Conflict**: two conversations disagree.
- **Live capture**: saved by the browser extension and not yet confirmed by an official export.

**Good habits:**
- Request a ChatGPT export when the dashboard reminds you.
- Say decisions clearly in ChatGPT ("Decision: we'll go with …"). The app recognises them most reliably that way,
  especially without AI.
