# Gemini Finance Bot — Project Guide & Context

> **Purpose of this file:** A single source of truth for what this bot does, how it's
> built, and *why* the key decisions were made. Attach or mention this file at the start
> of a new session to continue seamlessly without re-explaining context.
>
> **Last updated:** 2026-07-21

---

## 1. What this is

A Telegram bot that tracks **group trip expenses** and calculates **who owes whom**.
Built on **Google Apps Script** (a single `.gs` file deployed as a web app), it uses
**Gemini 2.5 Flash** to parse natural-language expense messages ("coffee 5 sayuri") and
**Google Sheets** as the database (one tab per chat).

**Primary use case:** Sayuri + Chloe (and friends) tracking a trip — currently a
Queenstown, NZ trip. Defaults are tuned for this: **NZD** currency, **Pacific/Auckland**
timezone.

---

## 2. Architecture at a glance

```
Telegram chat  ──webhook──▶  doPost(e)  ──▶  command router
                                              │
                    ┌─────────────────────────┼──────────────────────────┐
                    ▼                          ▼                          ▼
              Gemini 2.5 Flash          Google Sheets            Script Properties
           (parse text / receipt)   (one tab per chat)      (per-chat settings/state)
```

- **`src/gemini-bot.en.gs`** — the entire bot. One file. All logic lives here.
- **Entry point:** `doPost(e)` receives Telegram webhook updates.
- **Health check:** `doGet()` returns a plain-text "running" message (must use
  `ContentService`, NOT `HtmlService` — see Gotchas).
- **Storage:**
  - **Google Sheets** — transaction rows. Columns: `Timestamp | User | Type | Amount | Note | Category | PaidBy`.
  - **Script Properties** — per-chat config keyed by chatId: `CURRENCY_<id>`,
    `TIMEZONE_<id>`, `TONE_<id>`, `LANGUAGE_<id>`, `MEMBERS_<id>`, `SHEET_TAB_<id>`,
    `LAST_UNDO_ROW_<id>`, `REMINDERS_<id>`.

### Configuration constants (top of the file)
```javascript
const DEFAULT_CURRENCY = "NZD";
const DEFAULT_TIMEZONE = "Pacific/Auckland";
const TRIP_MEMBERS     = ["Sayuri", "Chloe"];   // default roster until /setmembers
const REMIND_HOUR = 20;  // daily reminder
const REPORT_HOUR = 21;  // daily report
```
Secrets (`BOT_TOKEN`, `GEMINI_KEY`, `SHEET_ID`, `ADMIN_CHAT_ID`) are placeholders in the
repo and filled in inside the Apps Script editor — **never commit real values**.

### Supported currencies
KRW, NZD, USD, AUD, PHP, EUR, GBP, JPY. `k`/`m` shorthand ("10k" = 10,000) works for
**every** currency; only decimal places differ (0 for KRW/JPY, 2 for the rest).

---

## 3. Commands (full reference)

| Command | What it does |
|---|---|
| `/start` | Onboarding — numbered setup steps for anything not yet configured |
| `/help` | Full command reference |
| `/whoami` | Shows chat ID, currency, sheet tab, members, timezone |
| **Recording** | |
| *(plain text)* | e.g. `coffee 5 sayuri` — Gemini parses & records. Multi-line = multiple transactions |
| *(photo)* | Send a receipt photo → Gemini Vision extracts the total |
| **Reports** | |
| `/report` | Overall income vs expense |
| `/reportday` | Today only |
| `/reportmonth` | This month |
| `/reportcategory` | Expenses grouped by category |
| `/topcategory` | Top spending category this month |
| **Trip / people** | |
| `/trip` | Full trip summary per person |
| `/today` | Today's expenses by person |
| `/person <name>` | All transactions by one person (supports multi-word names) |
| `/settle` | Who pays whom (equal split, minimum transfers) |
| `/settle <from> paid <to> <amt> [comment]` | **Record a repayment** — e.g. `/settle Chloe paid Sayuri 50 for dinner` (comment optional) |
| `/summary` | `/trip` + `/settle` concatenated into one recap — for wrapping up a trip |
| **History / editing** | |
| `/list` / `/list 20` | Last N transactions with IDs |
| `/delete <id>` | Delete a transaction by ID |
| `/edit <id> <field> <value>` | Edit note / amount / payer / category |
| `/search <keyword>` | Search transactions |
| `/undo` → `/confirm` | Undo the last transaction (two-step) |
| **Trip lifecycle** | |
| `/newtrip [name]` | Archive current trip, start a fresh sheet tab |
| **Settings** | |
| `/setmembers <names>` | Set roster. **Comma-separate multi-word names** |
| `/setcurrency <code>` | Set currency |
| `/settimezone <tz>` | Set timezone (IANA, e.g. `Pacific/Auckland`) |
| `/settone <friendly\|savage>` | Set reaction tone — `friendly` (default) or `savage` (playful roast) |
| `/setlanguage <en\|tl>` | Set reaction language — `en` (default) or `tl` (Filipino/Taglish) |
| `/reminders on/off` | Toggle daily reminders |

---

## 4. Key design decisions (the "why")

- **HTML parse mode everywhere (not Markdown).** All outgoing messages use Telegram's
  HTML mode, and **every** interpolated free-text value (notes, names, categories,
  search keywords) passes through `escapeHtml()`. Reason: a value like "fish & chips"
  produces an invalid entity, Telegram returns 400, and because `sendMessage` uses
  `muteHttpExceptions` the failure is **silent** — the message just never sends. This
  bit us repeatedly; escaping is mandatory for any new interpolation.

- **Timezone-aware dates via `Utilities.formatDate(date, getTimezone(chatId), ...)`.**
  Never use JS `Date.toString()` / raw interpolation — that uses the Apps Script
  *project* timezone (which was set to KST when the project was created) and ignores the
  chat's configured zone. Every date-formatting and date-comparison site must go through
  the chat timezone.

- **`k`/`m` shorthand is universal.** Originally KRW-only via a per-currency flag;
  removed the flag entirely. `parseAmountInput()` handles it for all currencies;
  `currency.decimals` only affects *display* formatting.

- **One sheet tab per chat, named by chat title.** `getSheetTabName()` derives the tab
  name from the Telegram chat title (group name or user's name), sanitized. Old numeric
  tabs auto-upgrade on next message. The first chat to message claims the legacy
  "Transactions" tab so original data isn't lost. All mutations run inside a
  `LockService` lock to prevent concurrent-webhook races.

- **Structured returns, not sentinel strings.** e.g. `editTransaction` returns
  `{display}` on success / `{error: "..."}` on failure — so a note legitimately edited
  to the text "notfound" isn't mistaken for a failure.

- **Group-chat silence.** In group chats (`chatId < 0`), the bot skips Gemini entirely
  for messages with no digits, and stays silent when it can't parse a message — so it
  doesn't spam normal conversation. In DMs it still replies with helpful errors.

- **Repayments as their own row type.** `/settle X paid Y <amt> [comment]` stores a
  `repayment` row (reusing columns: `User`=from, `PaidBy`=to, `Note`=optional comment,
  `Category`="Repayment"). Shared parsing lives in `parseRepayment()`: it splits at the
  **first** " paid " (so a comment containing the word "paid" doesn't break the match)
  and treats the first numeric token on the right as the amount, so multi-word names
  stay intact and anything after the amount becomes the comment (leading "for"
  stripped). Both names are resolved against the roster — an unrecognized name is
  rejected rather than silently becoming a phantom member that dilutes the equal share.
  Repayments are subtracted from the settlement math but **excluded** from `/report`,
  `/trip`, `/today`, `/person` (they filter to `expense` only), and rendered as
  "from → to (comment)" with a 🔄 emoji in `/list`, `/search`, `/undo`, and `/delete`.
  `/edit` refuses to touch `payer`/`category` on a repayment row (only `note`/`amount`
  are safe — the columns mean something different for this row type); attempting it
  returns a clear "delete and re-record" message instead of silently corrupting the row.
  `getSettlement` only shows "no expenses to settle" when there are truly zero rows of
  either kind — a repayment recorded before any expense still surfaces. No schema
  migration needed.

- **Plain-text "X paid Y" is intercepted before Gemini, not just `/settle`.** Gemini's
  parsing prompt teaches it "name before 'paid'" as an *expense* pattern (for phrasing
  like "chloe paid 1350 for dinner"), so a bare message like `Chloe paid Sayuri 50`
  would otherwise be booked as an expense and inflate the settlement pot — exactly
  backwards for a repayment. `doPost` runs `parseRepayment()` against the roster before
  calling Gemini (both the single-line and per-line multi-line paths); if it matches a
  real "member paid member amount" shape, it's recorded as a repayment and Gemini is
  never called for that line.

- **Bot-join detection uses `my_chat_member`, not `new_chat_members`.** The latter is
  unreliable in modern supergroups. `my_chat_member` fires reliably; we welcome only on
  a genuine join transition (absent → present) so promotions/demotions don't re-welcome.

- **Personality toggle is two independent settings, not one.** Tone (`friendly`/`savage`)
  and language (`en`/`tl`) are separate `/settone` / `/setlanguage` commands with separate
  Script Properties, mirroring `/setcurrency`/`/settimezone` — so a chat can mix and match
  (e.g. savage-in-English, or friendly-in-Taglish) instead of one combined "personality"
  command. Both are opt-in; unset defaults to the current behavior (friendly, English).
  Only the Gemini-generated `reaction` field is affected — `buildReactionRules(tone,
  language)` builds a shared instruction block consumed by both
  `parseAndReactWithGemini` (text messages) and `handleReceiptPhoto` (receipt OCR), so
  the two prompts can't drift out of sync. Savage is scoped to roasting the *purchase*
  (price, choice, frequency) — the prompt explicitly forbids insulting the person, any
  protected trait, or using profanity, so it stays playful banter rather than something
  that could land as genuinely hurtful.

---

## 5. Deployment & operations

### Deploy code changes
1. Open the Apps Script project (script.google.com)
2. Paste the updated `src/gemini-bot.en.gs`
3. **Deploy → Manage deployments → edit (pencil) → Version: "New version" → Deploy**
4. Saving alone is NOT enough — the webhook is pinned to a deployment version, so you
   must publish a new version each time.

### Register / update the webhook (only when needed)
Run `setup()` from the editor, **passing your published `/exec` URL**:
```javascript
setup("https://script.google.com/macros/s/AKfy.../exec")
```
- `setup()` registers the webhook with `allowed_updates: ["message", "callback_query", "my_chat_member"]`.
- It **refuses** to register a `/dev` URL (a common Apps Script footgun).
- You only need this once, or whenever you change which update types you receive.
  Normal code deploys do **not** need it.

### Update BotFather command list
`@BotFather` → `/mybots` → select bot → **Edit Bot → Edit Commands** → paste the
`command - description` list (see README / section 3).

### Cosmetic: fix the project timezone
Apps Script **Project Settings (⚙️) → Time zone → (GMT+12:00) Auckland**. Purely
cosmetic now that all date formatting goes through the chat timezone.

---

## 6. Gotchas & lessons learned (things that bit us)

1. **Silent 400s from unescaped HTML** — always `escapeHtml()` interpolated free text.
2. **`Utilities.formatDate` never throws** — Java's `TimeZone.getTimeZone` silently
   returns GMT for unknown IDs, so timezone validation needs a two-date offset check
   (Jan vs Jul), not just a try/catch.
3. **`doGet` must use `ContentService.createTextOutput`** — `HtmlService.createTextOutput`
   doesn't exist.
4. **Sheet tab names can't contain `: \ / ? * [ ]`** — `insertSheet` throws and the
   `doPost` catch swallows it. Sanitize tab names.
5. **`/setmembers` splits on spaces without commas** — so "Kristel Chloe" becomes two
   members. Multi-word names need commas: `/setmembers Sayuri, Kristel Chloe`.
6. **Group chat IDs are negative** — `chatId < 0` reliably detects a group vs a DM.
7. **Callback queries** (inline buttons) arrive as `update.callback_query`, not
   `update.message` — normalized into a message-like object at the top of `doPost`.

---

## 7. Work history (what we've done & why)

Chronological summary of the changes made across sessions. Most recent last.

- **PR #3** — Fixed `doGet` to use `ContentService` (plain-text health check).
- **PR #4** — Receipt photo OCR, `/newtrip`, `/list` + `/delete`, message chunking
  (4096-char limit), `/reminders on/off`, multi-line transactions.
- **PR #5** — `/settimezone`, `/edit`, `/search`; timezone-aware date comparisons;
  callback-query (inline button) handling; `/person` fix for multi-word names;
  onboarding welcome on `/start` and bot-join; NZD + Pacific/Auckland defaults;
  universal `k`/`m` shorthand; HTML-escaping pass; `/help` Markdown→HTML fix.
- **PR #6** — Chat-title-based tab naming (auto-upgrade numeric tabs); `/setmembers`
  comma-hint warning; numbered onboarding steps; `my_chat_member` bot-join detection +
  `setup()` webhook registration. Peer-review fixes: single welcome path, escaping in
  the comma-hint, tab-upgrade moved inside the lock, `setup()` rejects `/dev` URLs.
- **PR #7** — Group-chat silence: skip Gemini for no-digit messages; stay silent on
  unparseable messages in groups (DMs still get helpful errors).
- **PR #8** — `/undo` date now uses the chat timezone (was showing KST); escaped
  `note`/`paidBy` in the undo confirmation.
- **PR #9** — **Repayment recording**: `/settle X paid Y <amt> [comment]` records a
  repayment that adjusts the settlement, with an optional comment ("for dinner"), roster
  validation, and no schema migration. Added this PROJECT_GUIDE and a README pointer.
  Peer-review follow-up: plain-text "X paid Y" is now intercepted before Gemini (was
  being booked as an expense); `/edit` refuses unsafe fields on repayment rows;
  `/undo`/`/delete` describe repayments correctly instead of with expense labels;
  `getSettlement` no longer hides a repayment-only balance; `/search` only matches the
  `User` column for repayment rows (was inflating expense-search totals); repayment
  parsing consolidated into a single `parseRepayment()` helper used by both `/settle`
  and the plain-text path. Also added `/summary` — `getTripSummary()` +
  `getSettlement()` concatenated into one recap message for wrapping up a trip
  (dedupes the "no data" message when the sheet is empty rather than showing it twice).
- **Roast mode personality toggle** — two independent per-chat settings, `/settone
  friendly|savage` and `/setlanguage en|tl` (default: friendly, English), stored as
  `TONE_<id>`/`LANGUAGE_<id>` Script Properties via `getTone`/`setTone`/`getLanguage`/
  `setLanguage`. Threaded into both Gemini call sites that generate a `reaction`
  (`parseAndReactWithGemini` and `handleReceiptPhoto`) via a shared `buildReactionRules()`
  prompt-builder. Savage mode is a playful, exaggerated roast of the purchase
  (mumu-app-inspired, e.g. "1000 pesos for a carwash?? does it come with a hand and foot
  spa too?"), explicitly barred from insulting the person, any protected trait, or using
  profanity. `/whoami` and `/help` now show the active tone/language; `/start`'s
  onboarding mentions the toggle as an optional extra (not a required setup step).

---

## 8. Known open items / ideas

- **Stray income row:** An `income` row was created accidentally by Gemini (it tags
  "received money back / reimbursed" as income). It shows only in `/report` and doesn't
  affect `/settle`. **Still needs manual cleanup** — find it with `/list` (or
  `/list 20`, look for the 💰 emoji) and remove it with `/delete <id>`. This can only be
  done from Telegram; there's no sheet-level access from this codebase/session. Now
  that repayments have a proper home, this misuse of `income` shouldn't recur.
- Possible future: validate/limit when Gemini invents an `income` type; a `/balance`
  per-person quick view.

---

## 9. Working agreement / conventions

- **Branch:** development happens on `claude/trip-expense-tracker-SdqhA`; PRs target `main`.
- **Don't over-build.** The user explicitly prefers lean, justified changes over
  speculative features. When proposing a feature, give an honest "is this worth it" take.
- **Peer review before merge.** We do a self/peer review pass on each PR and apply the
  real bugs found (skipping style nits).
- **Keep this guide current.** Whenever a change adds/alters a command, decision, or
  gotcha, update this file (sections 3, 4, 6, 7) as part of the same PR.
- **Secrets never committed.** Real tokens/keys live only in the Apps Script editor.
