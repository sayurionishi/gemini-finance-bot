// =====================================================
// MIT License © 2025 Nghia Nguyen
// Adapted for group trip expense tracking
// =====================================================

// =====================================================
// CONFIGURATION
// =====================================================
const BOT_TOKEN     = 'YOUR_TELEGRAM_TOKEN';
const GEMINI_KEY    = 'YOUR_GEMINI_API_KEY';
const SHEET_ID      = 'YOUR_SHEET_ID';
const TG_API        = 'https://api.telegram.org/bot' + BOT_TOKEN;
const ADMIN_CHAT_ID = 'YOUR_CHAT_ID';
const REMIND_HOUR   = 20;
const REPORT_HOUR   = 21;

// Default member roster used when a chat hasn't set its own via /setmembers.
// Per-chat rosters take precedence — see getMembers().
const TRIP_MEMBERS = ["Sayuri", "Chloe"];

// Supported currencies — extend as needed.
// shorthands: true enables "10k" = 10,000 / "1.5k" = 1,500 parsing in Gemini.
const CURRENCIES = {
  KRW: { code: "KRW", symbol: "₩", decimals: 0, name: "Korean Won",       shorthands: true  },
  NZD: { code: "NZD", symbol: "$", decimals: 2, name: "NZ Dollar",         shorthands: false },
  USD: { code: "USD", symbol: "$", decimals: 2, name: "US Dollar",         shorthands: false },
  AUD: { code: "AUD", symbol: "$", decimals: 2, name: "AU Dollar",         shorthands: false },
  PHP: { code: "PHP", symbol: "₱", decimals: 2, name: "Philippine Peso",   shorthands: false },
  EUR: { code: "EUR", symbol: "€", decimals: 2, name: "Euro",              shorthands: false },
  GBP: { code: "GBP", symbol: "£", decimals: 2, name: "British Pound",     shorthands: false },
  JPY: { code: "JPY", symbol: "¥", decimals: 0, name: "Japanese Yen",      shorthands: false },
};

// =====================================================
// CURRENCY HELPERS
// =====================================================

// Returns the currency config for a chat. Defaults to KRW.
function getCurrency(chatId) {
  const code = PropertiesService.getScriptProperties().getProperty(`CURRENCY_${chatId}`) || "KRW";
  return CURRENCIES[code] || CURRENCIES.KRW;
}

// Stores the currency choice for a chat. Returns false if code is unknown.
function setCurrency(chatId, code) {
  const upper = code.toUpperCase().trim();
  if (!CURRENCIES[upper]) return false;
  PropertiesService.getScriptProperties().setProperty(`CURRENCY_${chatId}`, upper);
  return true;
}

// Returns the active member roster for a chat.
// Per-chat roster if set, otherwise falls back to the global TRIP_MEMBERS.
function getMembers(chatId) {
  const raw = PropertiesService.getScriptProperties().getProperty(`MEMBERS_${chatId}`);
  if (!raw) return TRIP_MEMBERS;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : TRIP_MEMBERS;
  } catch (e) {
    return TRIP_MEMBERS;
  }
}

// True if a per-chat roster has been explicitly set.
function hasCustomMembers(chatId) {
  return PropertiesService.getScriptProperties().getProperty(`MEMBERS_${chatId}`) !== null;
}

// Stores the roster for a chat. Returns false if the list is empty after cleaning.
function setMembers(chatId, names) {
  const cleaned = [...new Set(names.map(n => n.trim()).filter(Boolean))];
  if (cleaned.length === 0) return false;
  PropertiesService.getScriptProperties().setProperty(
    `MEMBERS_${chatId}`,
    JSON.stringify(cleaned)
  );
  return true;
}

// Formats a number with the correct symbol and decimal places.
// Negative numbers are shown as "-₩50,000", not "₩-50,000".
function formatAmount(amount, currency) {
  const num = Number(amount) || 0;
  const sign = num < 0 ? '-' : '';
  const abs = Math.abs(num);
  const body = currency.decimals === 0
    ? Math.round(abs).toLocaleString()
    : abs.toFixed(currency.decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return sign + currency.symbol + body;
}

// Sends a message, splitting it into ≤4000-char chunks on line boundaries so
// Telegram's 4096-char limit is never exceeded by long reports.
function sendChunked(chatId, text, mode = "HTML") {
  const MAX = 4000;
  if (text.length <= MAX) { sendMessage(chatId, text, mode); return; }
  const lines = text.split("\n");
  let chunk = "";
  for (const line of lines) {
    const next = chunk ? chunk + "\n" + line : line;
    if (next.length > MAX) {
      if (chunk) sendMessage(chatId, chunk, mode);
      chunk = line;
    } else {
      chunk = next;
    }
  }
  if (chunk) sendMessage(chatId, chunk, mode);
}

// =====================================================
// SHEET TAB ROUTING — one tab per chat
// =====================================================

// Returns the sheet tab name for this chatId.
// The first chatId to call this claims the legacy "Transactions" tab so existing
// data isn't lost. Every new chatId after that gets its own tab named by chatId.
// LockService prevents two concurrent webhooks from both claiming "Transactions".
function getSheetTabName(chatId) {
  const props = PropertiesService.getScriptProperties();
  const key = `SHEET_TAB_${chatId}`;
  const cached = props.getProperty(key);
  if (cached) return cached;

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
    // Re-check inside the lock — another invocation may have set it while we waited
    const recheck = props.getProperty(key);
    if (recheck) return recheck;

    const ss = SpreadsheetApp.openById(SHEET_ID);
    const transTab = ss.getSheetByName("Transactions");
    // One round-trip instead of N+1 per-key reads
    const allProps = props.getProperties();
    const alreadyClaimed = Object.entries(allProps).some(
      ([k, v]) => k.startsWith("SHEET_TAB_") && v === "Transactions"
    );
    const tabName = (transTab && !alreadyClaimed) ? "Transactions" : String(chatId);
    props.setProperty(key, tabName);
    return tabName;
  } finally {
    lock.releaseLock();
  }
}

// =====================================================
// WEBHOOK ENTRY POINT
// =====================================================
function doPost(e) {
  try {
    const update = JSON.parse(e.postData.contents);
    const msg = update.message;
    if (!msg || msg.from?.is_bot) return HtmlService.createHtmlOutput("ignored");

    const chatId = msg.chat.id;
    const text = msg.text?.trim() || "";

    // Receipt OCR: handle photo messages before the text guard
    if (msg.photo) {
      handleReceiptPhoto(msg, chatId);
      return HtmlService.createHtmlOutput("ok");
    }

    if (!text) return HtmlService.createHtmlOutput("no text");

    // Strip Telegram's @BotName suffix added in group chats (e.g. "/person@MyBot Sayuri")
    const cleanText = text.replace(/^(\/\w+)@\w+/, '$1');
    const command = cleanText.toLowerCase();
    const commandBase = command.split(' ')[0];
    // Args keep original casing so names like "Sayuri" aren't lowercased
    const args = cleanText.substring(commandBase.length).trim();

    const currency = getCurrency(chatId);

    // =====================================================
    // BASIC COMMANDS
    // =====================================================
    if (command === "/start" || command === "/help") {
      ensureSheet(chatId);
      const supported = Object.keys(CURRENCIES).join(", ");
      const helpText =
        "👋 Hello *" + (msg.from.first_name || "there") + "!*\n\n" +
        "I'm *Gemini Finance Bot* 💰 – your expense tracker.\n\n" +
        "🧾 Log expenses naturally:\n" +
        "• `lunch 10k sayuri` (KRW shorthand)\n" +
        "• `coffee 5.50 - chloe` (decimal currency)\n" +
        "• Multi-line: send several transactions at once\n" +
        "• 📷 Send a receipt photo to scan it automatically!\n\n" +
        "📊 Report commands:\n" +
        "• `/report` – Overall report\n" +
        "• `/reportday` – Today's report\n" +
        "• `/reportmonth` – Monthly report\n" +
        "• `/reportcategory` – Report by category\n" +
        "• `/topcategory` – Top spending category\n\n" +
        "✈️ Trip commands:\n" +
        "• `/trip` – Full trip summary per person\n" +
        "• `/today` – Today's expenses by person\n" +
        "• `/person <name>` – All transactions by a person\n" +
        "• `/settle` – Settlement: who pays whom\n\n" +
        "📋 History:\n" +
        "• `/list` – Last 10 transactions with IDs\n" +
        "• `/list 20` – Last 20 transactions\n" +
        "• `/delete <id>` – Delete transaction by ID\n\n" +
        "🗂️ Trip lifecycle:\n" +
        "• `/newtrip [name]` – Archive current trip, start fresh\n\n" +
        "🛠️ Settings & other:\n" +
        "• `/setmembers <names>` – Set trip members for this chat\n" +
        "• `/setcurrency <code>` – Set currency (" + supported + ")\n" +
        "• `/reminders on/off` – Toggle daily reminders\n" +
        "• `/undo` – Undo last transaction\n" +
        "• `/confirm` – Confirm deletion\n" +
        "• `/whoami` – Chat ID, currency, tab & members\n\n" +
        "⏰ Daily reminder at " + REMIND_HOUR + ":00, report at " + REPORT_HOUR + ":00.\n\n" +
        "💱 Current currency: *" + currency.code + "* (" + currency.symbol + ")";
      sendMessage(chatId, helpText, "Markdown");
      return HtmlService.createHtmlOutput("ok");
    }

    if (command === "/whoami") {
      const tabName = getSheetTabName(chatId);
      const members = getMembers(chatId);
      const memberLabel = hasCustomMembers(chatId) ? "" : " <i>(default)</i>";
      sendMessage(chatId,
        `🪪 <b>Chat ID:</b> <code>${chatId}</code>\n` +
        `💱 <b>Currency:</b> ${currency.code} (${currency.symbol})\n` +
        `📋 <b>Sheet tab:</b> ${tabName}\n` +
        `👥 <b>Members:</b> ${members.join(", ")}${memberLabel}`,
        "HTML");
      return HtmlService.createHtmlOutput("ok");
    }

    // /setmembers Sayuri Chloe Alex  (or comma-separated)
    if (commandBase === "/setmembers") {
      if (!args) {
        const current = getMembers(chatId);
        const label = hasCustomMembers(chatId) ? "" : " <i>(default)</i>";
        sendMessage(chatId,
          `👥 <b>Current members:</b> ${current.join(", ")}${label}\n\n` +
          `Set new list:\n` +
          `<code>/setmembers Sayuri Chloe Alex</code>\n` +
          `<code>/setmembers Sayuri, Chloe, Alex</code>`,
          "HTML");
        return HtmlService.createHtmlOutput("ok");
      }
      // Accept comma- or space-separated input; title-case each name
      const rawNames = args.includes(',') ? args.split(',') : args.split(/\s+/);
      const names = rawNames.map(s => toTitleCase(s.trim())).filter(Boolean);
      if (setMembers(chatId, names)) {
        sendMessage(chatId,
          `✅ Members set to: <b>${names.join(", ")}</b>\n\n` +
          `Future transactions will recognize these names. ` +
          `Existing data is untouched — old payers still appear in /settle.`,
          "HTML");
      } else {
        sendMessage(chatId, `⚠️ Please provide at least one name.\nExample: <code>/setmembers Sayuri Chloe Alex</code>`, "HTML");
      }
      return HtmlService.createHtmlOutput("ok");
    }

    // /setcurrency NZD
    if (commandBase === "/setcurrency") {
      // First token only — "/setcurrency NZD extra" → "NZD"
      const code = (args.split(/\s+/)[0] || "").toUpperCase();
      const supported = Object.keys(CURRENCIES).join(", ");
      if (!code) {
        sendMessage(chatId, `💱 Supported currencies: <b>${supported}</b>\nExample: <code>/setcurrency NZD</code>`, "HTML");
        return HtmlService.createHtmlOutput("ok");
      }
      if (setCurrency(chatId, code)) {
        const cur = getCurrency(chatId);
        sendMessage(chatId,
          `✅ Currency set to <b>${cur.code}</b> (${cur.symbol}) — ${cur.name}.\n` +
          `All amounts in this chat will now use ${cur.symbol}`, "HTML");
      } else {
        sendMessage(chatId, `⚠️ Unknown currency code.\nSupported: <b>${supported}</b>`, "HTML");
      }
      return HtmlService.createHtmlOutput("ok");
    }

    if (["/report", "/reportday", "/reportmonth", "/reportcategory", "/topcategory"].includes(command)) {
      if (command === "/reportcategory") {
        sendChunked(chatId, getCategoryReport(chatId), "HTML");
        return HtmlService.createHtmlOutput("ok");
      }
      if (command === "/topcategory") {
        sendChunked(chatId, getTopCategoryReport(chatId), "HTML");
        return HtmlService.createHtmlOutput("ok");
      }
      let mode = "all";
      if (command === "/reportday") mode = "day";
      if (command === "/reportmonth") mode = "month";
      sendChunked(chatId, getFinanceReport(mode, chatId), "HTML");
      return HtmlService.createHtmlOutput("ok");
    }

    // =====================================================
    // TRIP COMMANDS
    // =====================================================
    if (command === "/trip") {
      sendChunked(chatId, getTripSummary(chatId), "HTML");
      return HtmlService.createHtmlOutput("ok");
    }

    if (command === "/today") {
      sendChunked(chatId, getTodayByPerson(chatId), "HTML");
      return HtmlService.createHtmlOutput("ok");
    }

    if (commandBase === "/person") {
      // Only take the first token — "/person Sayuri loves coffee" → "Sayuri"
      const name = args ? toTitleCase(args.split(/\s+/)[0]) : "";
      sendChunked(chatId, getPersonTransactions(name, chatId), "HTML");
      return HtmlService.createHtmlOutput("ok");
    }

    if (command === "/settle") {
      sendChunked(chatId, getSettlement(chatId), "HTML");
      return HtmlService.createHtmlOutput("ok");
    }

    // =====================================================
    // HISTORY COMMANDS
    // =====================================================

    // /list [n] — show last N transactions with row IDs
    if (commandBase === "/list") {
      const n = parseInt(args) || 10;
      sendChunked(chatId, listTransactions(chatId, n), "HTML");
      return HtmlService.createHtmlOutput("ok");
    }

    // /delete <id> — delete transaction by row ID from /list
    if (commandBase === "/delete") {
      const rowNum = parseInt(args);
      if (!rowNum || rowNum <= 1) {
        sendMessage(chatId,
          "⚠️ Please provide a valid transaction ID.\n" +
          "Example: <code>/delete 12</code>\n\nUse /list to see IDs.", "HTML");
        return HtmlService.createHtmlOutput("ok");
      }
      const deleted = deleteTransactionById(chatId, rowNum);
      if (!deleted) {
        sendMessage(chatId,
          `⚠️ Transaction <code>#${rowNum}</code> not found.\nUse /list to see valid IDs.`, "HTML");
      } else {
        const [, , type, amt, note, , paidBy] = deleted;
        sendMessage(chatId,
          `🗑️ Deleted <code>#${rowNum}</code>:\n` +
          `• <b>${note || "?"}</b> ${formatAmount(Number(amt || 0), currency)}\n` +
          `• Paid by: ${paidBy || "?"}`,
          "HTML");
      }
      return HtmlService.createHtmlOutput("ok");
    }

    // =====================================================
    // TRIP LIFECYCLE
    // =====================================================

    // /newtrip [name] — archive current tab, start fresh
    if (commandBase === "/newtrip") {
      const tripName = args ? args.substring(0, 30) : "";
      const result = startNewTrip(chatId, tripName);
      sendMessage(chatId,
        `🗂️ <b>New trip started!</b>\n\n` +
        `📦 Old data archived: <code>${result.archivedTab}</code>\n` +
        `✨ New tab: <code>${result.newTab}</code>\n\n` +
        `All commands now record to the new tab. Old data is preserved.`,
        "HTML");
      return HtmlService.createHtmlOutput("ok");
    }

    // =====================================================
    // REMINDER TOGGLE
    // =====================================================
    if (commandBase === "/reminders") {
      const sub = args.toLowerCase();
      if (sub === "off") {
        setRemindersEnabled(chatId, false);
        sendMessage(chatId, "🔕 Daily reminders disabled.\nUse /reminders on to re-enable.");
      } else if (sub === "on") {
        setRemindersEnabled(chatId, true);
        sendMessage(chatId, "🔔 Daily reminders enabled.");
      } else {
        const status = isRemindersEnabled(chatId) ? "🔔 <b>ON</b>" : "🔕 <b>OFF</b>";
        sendMessage(chatId,
          `Daily reminders: ${status}\n\nUse /reminders on or /reminders off.`, "HTML");
      }
      return HtmlService.createHtmlOutput("ok");
    }

    // =====================================================
    // UNDO + CONFIRM HANDLING
    // =====================================================
    if (command === "/undo") {
      const last = getLastTransaction(chatId);
      if (!last) {
        sendMessage(chatId, "⚠️ No recent transaction found to delete.");
        return HtmlService.createHtmlOutput("ok");
      }
      const confirmText =
        `❗ <b>Last transaction:</b>\n` +
        `📅 ${last.date}\n💬 ${last.note}\n` +
        `💸 ${last.type} ${formatAmount(last.amount, currency)} (${last.category || "Uncategorized"})\n` +
        `👤 Paid by: ${last.paidBy || "Unknown"}\n\n` +
        `Reply with <b>/confirm</b> to delete this transaction.`;
      sendMessage(chatId, confirmText, "HTML");
      return HtmlService.createHtmlOutput("ok");
    }

    if (command === "/confirm") {
      const deleted = deleteLastTransaction(chatId);
      sendMessage(chatId, deleted ? "✅ Last transaction deleted!" : "⚠️ Nothing to delete.");
      return HtmlService.createHtmlOutput("ok");
    }

    // =====================================================
    // AI-BASED NATURAL TRANSACTION HANDLING
    // Supports multi-line messages: each non-empty line is
    // treated as a separate transaction and recorded
    // independently. Single-line messages work as before.
    // =====================================================
    const senderName = msg.from.first_name || "User";
    const members = getMembers(chatId);

    const lines = text.split("\n").map(l => l.trim()).filter(l => l.length > 0);
    if (lines.length > 1) {
      // Multi-line: parse each line, collect successes and failures
      const successes = [];
      const failures = [];
      for (const line of lines) {
        const p = parseAndReactWithGemini(line, senderName, currency, members);
        if (p?.amount != null) p.amount = Number(p.amount);
        if (!p?.amount || !p?.type) {
          failures.push(line);
        } else {
          appendToSheet(p, senderName, chatId);
          successes.push(p);
        }
      }
      if (successes.length === 0) {
        sendMessage(chatId,
          "🤔 I couldn't understand any of those lines. Could you rephrase?\n\n" +
          "Example:\n<code>coffee 10k sayuri\nbread 2k chloe</code>", "HTML");
        return HtmlService.createHtmlOutput("unclear");
      }
      const rows = successes.map(p => {
        const paidByLabel = p.paidBy || senderName;
        return `• <b>${p.note || p.type}</b> ${formatAmount(p.amount, currency)} — ${paidByLabel}`;
      });
      let reply = `✅ Recorded ${successes.length} transaction${successes.length > 1 ? "s" : ""}:\n` + rows.join("\n");
      if (failures.length > 0) {
        reply += `\n\n⚠️ Couldn't parse:\n` + failures.map(f => `• ${f}`).join("\n");
      }
      sendChunked(chatId, reply, "HTML");
      return HtmlService.createHtmlOutput("ok");
    }

    // Single-line (original flow)
    const parsed = parseAndReactWithGemini(text, senderName, currency, members);
    // Gemini sometimes returns amounts as strings — coerce early so formatAmount works correctly
    if (parsed?.amount != null) parsed.amount = Number(parsed.amount);
    if (!parsed?.amount || !parsed?.type) {
      sendMessage(chatId,
        "🤔 I couldn't quite understand that transaction. Could you rephrase?\n\n" +
        "Example: <code>lunch 10k sayuri</code> or <code>coffee 5.50 - chloe</code>", "HTML");
      return HtmlService.createHtmlOutput("unclear");
    }

    appendToSheet(parsed, senderName, chatId);
    const paidByLabel = parsed.paidBy || senderName;
    const reply =
      `✅ Recorded: <b>${parsed.type}</b> ${formatAmount(parsed.amount, currency)} — ${parsed.note || ""}\n` +
      `🏷️ Category: <b>${parsed.category || "Other"}</b>\n` +
      `👤 Paid by: <b>${paidByLabel}</b>\n\n${parsed.reaction}`;
    sendMessage(chatId, reply, "HTML");
    return HtmlService.createHtmlOutput("ok");

  } catch (err) {
    Logger.log("Error: " + err);
    return HtmlService.createHtmlOutput("error");
  }
}

// =====================================================
// GEMINI PARSER — extracts amount, type, category,
// paidBy name, and a friendly reaction emoji string.
// Amount rules adapt to the chat's configured currency.
// =====================================================
function parseAndReactWithGemini(text, userName, currency, members) {
  try {
    const memberList = members.join(", ");
    const amountRules = currency.shorthands
      ? `- "10k" means 10,000, "1.5k" means 1,500, "10m" means 10,000,000\n- Currency is ${currency.name} (${currency.code}). Return amount as a plain integer.`
      : `- Currency is ${currency.name} (${currency.code}). Return amount as a number with up to ${currency.decimals} decimal places (e.g. 5.50).`;

    const prompt = `
You are a friendly group expense assistant.
Analyze the following message and extract the transaction details.

Trip members (these are the only valid payer names): ${memberList}

Amount rules:
${amountRules}

PaidBy rules (find the person who actually paid):
- ONLY use a name from the trip members list above (case-insensitive match)
- Name at the end of the message: "lunch 10k sayuri" → paidBy = "Sayuri"
- Name after a dash or hyphen: "coffee 5000 - chloe" → paidBy = "Chloe"
- Name before "paid": "chloe paid 1350 for dinner" → paidBy = "Chloe"
- Words that are NOT trip-member names (places, foods, notes) are never payers
  e.g. "lunch 10000 in cheonan" → no name found → paidBy = sender's name
- If no valid name is found, use the sender's name: "${userName}"
- Always normalize paidBy to Title Case (e.g. "sayuri" → "Sayuri")

Category options: Food, Transport, Accommodation, Activities, Shopping, Other

For expense tracking, type is almost always "expense".
Use "income" only if someone explicitly received money back or was reimbursed.

Return ONLY a raw JSON object — no markdown fences, no explanation:
{
  "type": "expense" or "income",
  "amount": number,
  "note": "short description of what was purchased",
  "category": "Food | Transport | Accommodation | Activities | Shopping | Other",
  "paidBy": "Name in Title Case",
  "reaction": "short friendly reply with emojis (1-2 sentences)"
}

User message: "${text}"
Sender name: "${userName}"
`;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`;
    const res = UrlFetchApp.fetch(url, {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      muteHttpExceptions: true,
    });

    const data = JSON.parse(res.getContentText());
    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    return JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch (e) {
    Logger.log("Gemini parse error: " + e);
    return {};
  }
}

// =====================================================
// SHEET HANDLERS — 7 columns:
// Timestamp | User | Type | Amount | Note | Category | PaidBy
// Each chat gets its own tab via getSheetTabName().
// =====================================================
function ensureSheet(chatId) {
  const tabName = getSheetTabName(chatId);
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let sh = ss.getSheetByName(tabName);
  if (!sh) {
    sh = ss.insertSheet(tabName);
    sh.appendRow(["Timestamp", "User", "Type", "Amount", "Note", "Category", "PaidBy"]);
    return sh;
  }

  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];

  if (!headers.includes("Category")) {
    sh.getRange(1, 6).setValue("Category");
  }

  // Normalize legacy column names from older deployments
  ["Amount (USD)", "Amount (KRW)"].forEach(old => {
    const idx = headers.indexOf(old);
    if (idx !== -1) sh.getRange(1, idx + 1).setValue("Amount");
  });

  // Auto-add PaidBy column if this sheet predates it
  if (!headers.includes("PaidBy")) {
    sh.getRange(1, sh.getLastColumn() + 1).setValue("PaidBy");
  }
  return sh;
}

// Always go through ensureSheet so a brand-new chat that skips /start
// (e.g. fires /setcurrency then a transaction) still gets a header row.
function appendToSheet(parsed, user, chatId) {
  const sh = ensureSheet(chatId);
  sh.appendRow([
    new Date(),
    user,
    parsed.type,
    parsed.amount,
    parsed.note || "",
    parsed.category || "Other",
    parsed.paidBy || user
  ]);
}

// =====================================================
// UNDO HANDLING — keyed per chatId so chats don't conflict
// =====================================================
function getLastTransaction(chatId) {
  const tabName = getSheetTabName(chatId);
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sh = ss.getSheetByName(tabName);
  if (!sh || sh.getLastRow() <= 1) return null;

  const lastRow = sh.getLastRow();
  const row = sh.getRange(lastRow, 1, 1, sh.getLastColumn()).getValues()[0];

  PropertiesService.getScriptProperties().setProperty(`LAST_UNDO_ROW_${chatId}`, lastRow);

  return {
    date: row[0],
    user: row[1],
    type: row[2],
    amount: Number(row[3]),
    note: row[4],
    category: row[5],
    paidBy: row[6] || row[1]
  };
}

function deleteLastTransaction(chatId) {
  const tabName = getSheetTabName(chatId);
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sh = ss.getSheetByName(tabName);

  const lastRow = Number(PropertiesService.getScriptProperties().getProperty(`LAST_UNDO_ROW_${chatId}`));
  if (!lastRow || lastRow <= 1 || !sh) return false;

  try {
    sh.deleteRow(lastRow);
    PropertiesService.getScriptProperties().deleteProperty(`LAST_UNDO_ROW_${chatId}`);
    return true;
  } catch (err) {
    Logger.log("Undo deletion error: " + err);
    return false;
  }
}

// =====================================================
// REPORTING FUNCTIONS
// =====================================================
function getFinanceReport(mode = "all", chatId) {
  const tabName = getSheetTabName(chatId);
  const currency = getCurrency(chatId);
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sh = ss.getSheetByName(tabName);
  if (!sh) return "⚠️ No data available.";
  const data = sh.getDataRange().getValues();
  if (data.length <= 1) return "📭 No transactions recorded yet.";

  const today = new Date();
  const d = today.getDate(), m = today.getMonth(), y = today.getFullYear();
  let income = 0, expense = 0;

  for (let i = 1; i < data.length; i++) {
    const [ts, , type, amt] = data[i];
    if (!ts || !type || !amt) continue;
    const date = new Date(ts);
    if (mode === "day" && (date.getDate() !== d || date.getMonth() !== m || date.getFullYear() !== y)) continue;
    if (mode === "month" && (date.getMonth() !== m || date.getFullYear() !== y)) continue;
    if (type.toLowerCase() === "income")  income  += Number(amt);
    if (type.toLowerCase() === "expense") expense += Number(amt);
  }

  const balance = income - expense;
  const emoji = balance >= 0 ? "🟢" : "🔴";
  const title = mode === "day"   ? "📅 <b>Today's Report</b>"
              : mode === "month" ? "🗓️ <b>This Month's Report</b>"
              :                    "📊 <b>Overall Report</b>";
  return `${title}\n\n` +
    `💰 <b>Total Income:</b> ${formatAmount(income, currency)}\n` +
    `💸 <b>Total Expense:</b> ${formatAmount(expense, currency)}\n` +
    `${emoji} <b>Balance:</b> ${formatAmount(balance, currency)}\n\n` +
    `${balance >= 0 ? "Nice job managing your money 😎" : "Spending a bit high today 😅"}`;
}

function getCategoryReport(chatId) {
  const tabName = getSheetTabName(chatId);
  const currency = getCurrency(chatId);
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sh = ss.getSheetByName(tabName);
  if (!sh || sh.getLastRow() <= 1) return "📭 No data found.";
  const data = sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues();
  const totals = {};

  data.forEach(row => {
    const [ , , type, amt, , category ] = row;
    if (type.toLowerCase() === "expense")
      totals[category] = (totals[category] || 0) + Number(amt || 0);
  });

  const entries = Object.entries(totals);
  if (entries.length === 0) return "📭 No expense records yet.";
  entries.sort((a, b) => b[1] - a[1]);

  let result = "🏷️ <b>Expense by Category</b>\n\n";
  entries.forEach(([cat, val]) => result += `• ${cat}: ${formatAmount(val, currency)}\n`);
  return result;
}

function getTopCategoryReport(chatId) {
  const tabName = getSheetTabName(chatId);
  const currency = getCurrency(chatId);
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sh = ss.getSheetByName(tabName);
  if (!sh || sh.getLastRow() <= 1) return "📭 No expense data yet.";

  const today = new Date();
  const m = today.getMonth(), y = today.getFullYear();
  const data = sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues();
  const totals = {};

  data.forEach(row => {
    const [ts, , type, amt, , category] = row;
    const date = new Date(ts);
    if (type.toLowerCase() === "expense" && date.getMonth() === m && date.getFullYear() === y) {
      totals[category] = (totals[category] || 0) + Number(amt || 0);
    }
  });

  const entries = Object.entries(totals);
  if (entries.length === 0) return "📭 No expenses recorded this month.";
  entries.sort((a, b) => b[1] - a[1]);

  const total = entries.reduce((sum, e) => sum + e[1], 0);
  const [topCat, topVal] = entries[0];
  const percent = ((topVal / total) * 100).toFixed(1);

  return `📈 <b>Top Spending Category This Month</b>\n\n` +
    `🥇 <b>${topCat}</b>: ${formatAmount(topVal, currency)}\n` +
    `About ${percent}% of total expenses.\n\nKeep up the good financial habits 💪`;
}

// =====================================================
// TRIP SUMMARY — total trip spend, per-person breakdown,
// and how each person stands vs. the equal share
// =====================================================
function getTripSummary(chatId) {
  const tabName = getSheetTabName(chatId);
  const currency = getCurrency(chatId);
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sh = ss.getSheetByName(tabName);
  if (!sh || sh.getLastRow() <= 1) return "📭 No trip expenses recorded yet.";

  const data = sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues();
  const paid = {};
  let grandTotal = 0;

  data.forEach(row => {
    const [, user, type, amt, , , paidBy] = row;
    if (type.toLowerCase() !== "expense") return;
    const name = paidBy || user || "Unknown";
    paid[name] = (paid[name] || 0) + Number(amt || 0);
    grandTotal += Number(amt || 0);
  });

  if (grandTotal === 0) return "📭 No expenses recorded yet.";

  // Include the chat's roster even if they haven't paid anything yet, but also
  // include any existing payer in the sheet so removed members aren't dropped.
  const allMembers = [...new Set([...getMembers(chatId), ...Object.keys(paid)])];
  const share = grandTotal / allMembers.length;

  let result = `✈️ <b>Full Trip Summary</b>\n\n`;
  result += `💰 <b>Total Spent:</b> ${formatAmount(grandTotal, currency)}\n`;
  result += `➗ <b>Equal Share:</b> ${formatAmount(share, currency)} per person\n\n`;
  result += `<b>Paid by each person:</b>\n`;

  allMembers.sort().forEach(name => {
    const amt = paid[name] || 0;
    const diff = amt - share;
    const diffLabel = diff >= 0
      ? `<i>(+${formatAmount(diff, currency)} over)</i>`
      : `<i>(-${formatAmount(Math.abs(diff), currency)} under)</i>`;
    result += `• ${name}: ${formatAmount(amt, currency)} ${diffLabel}\n`;
  });

  result += `\nUse /settle to see who pays whom.`;
  return result;
}

// =====================================================
// TODAY BY PERSON — today's expenses itemized per payer
// =====================================================
function getTodayByPerson(chatId) {
  const tabName = getSheetTabName(chatId);
  const currency = getCurrency(chatId);
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sh = ss.getSheetByName(tabName);
  if (!sh || sh.getLastRow() <= 1) return "📭 No transactions yet.";

  const today = new Date();
  const d = today.getDate(), m = today.getMonth(), y = today.getFullYear();
  const data = sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues();
  const byPerson = {};

  data.forEach(row => {
    const [ts, user, type, amt, note, , paidBy] = row;
    if (!ts || type.toLowerCase() !== "expense") return;
    const date = new Date(ts);
    if (date.getDate() !== d || date.getMonth() !== m || date.getFullYear() !== y) return;
    const name = paidBy || user || "Unknown";
    if (!byPerson[name]) byPerson[name] = [];
    byPerson[name].push({ note, amt: Number(amt || 0) });
  });

  if (Object.keys(byPerson).length === 0) return "📭 No expenses logged today yet.";

  let result = `📅 <b>Today's Expenses by Person</b>\n\n`;
  Object.entries(byPerson).sort((a, b) => a[0].localeCompare(b[0])).forEach(([name, items]) => {
    const total = items.reduce((s, i) => s + i.amt, 0);
    result += `👤 <b>${name}</b> — ${formatAmount(total, currency)}\n`;
    items.forEach(i => result += `  • ${i.note}: ${formatAmount(i.amt, currency)}\n`);
    result += `\n`;
  });
  return result;
}

// =====================================================
// PERSON TRANSACTIONS — all trip expenses for one person
// =====================================================
function getPersonTransactions(name, chatId) {
  if (!name) return "⚠️ Please provide a name. Example: <code>/person Sayuri</code>";

  const tabName = getSheetTabName(chatId);
  const currency = getCurrency(chatId);
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sh = ss.getSheetByName(tabName);
  if (!sh || sh.getLastRow() <= 1) return "📭 No transactions yet.";

  const data = sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues();
  const rows = [];
  let total = 0;

  data.forEach(row => {
    const [ts, user, type, amt, note, category, paidBy] = row;
    if (!ts || type.toLowerCase() !== "expense") return;
    // Fall back to User so old rows without PaidBy are still queryable
    const effectivePayer = paidBy || user || "";
    if (effectivePayer.toLowerCase() !== name.toLowerCase()) return;
    rows.push({ ts: new Date(ts), note, amt: Number(amt || 0), category });
    total += Number(amt || 0);
  });

  if (rows.length === 0) return `📭 No expenses found for <b>${name}</b>.`;

  rows.sort((a, b) => a.ts - b.ts);
  let result = `👤 <b>Transactions by ${name}</b>\n\n`;
  rows.forEach(r => {
    const dateStr = `${r.ts.getMonth() + 1}/${r.ts.getDate()}`;
    result += `• [${dateStr}] ${r.note} — ${formatAmount(r.amt, currency)} (${r.category})\n`;
  });
  result += `\n💰 <b>Total paid:</b> ${formatAmount(total, currency)}`;
  return result;
}

// =====================================================
// SETTLEMENT — equal-split across the chat's members,
// greedy algorithm to minimise number of transfers
// =====================================================
function getSettlement(chatId) {
  const tabName = getSheetTabName(chatId);
  const currency = getCurrency(chatId);
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sh = ss.getSheetByName(tabName);
  if (!sh || sh.getLastRow() <= 1) return "📭 No trip expenses recorded yet.";

  const data = sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues();
  const paid = {};
  let grandTotal = 0;

  data.forEach(row => {
    const [, user, type, amt, , , paidBy] = row;
    if (type.toLowerCase() !== "expense") return;
    const name = paidBy || user || "Unknown";
    paid[name] = (paid[name] || 0) + Number(amt || 0);
    grandTotal += Number(amt || 0);
  });

  if (grandTotal === 0) return "📭 No expenses to settle.";

  // Include the chat's roster + anyone who has actually paid (so removed
  // members with existing transactions still appear)
  const allMembers = [...new Set([...getMembers(chatId), ...Object.keys(paid)])];
  const share = grandTotal / allMembers.length;

  // balance > 0 = owed money; balance < 0 = owes money
  const balance = {};
  allMembers.forEach(p => { balance[p] = (paid[p] || 0) - share; });

  // Greedy: repeatedly pair the biggest creditor with the biggest debtor
  const settlements = [];
  const bal = { ...balance };
  const minAmount = currency.decimals === 0 ? 1 : 0.01;
  for (let iter = 0; iter < 100; iter++) {
    const creditor = allMembers.reduce((best, p) => bal[p] > bal[best] ? p : best, allMembers[0]);
    const debtor   = allMembers.reduce((best, p) => bal[p] < bal[best] ? p : best, allMembers[0]);
    if (bal[creditor] < minAmount || bal[debtor] > -minAmount) break;
    const amount = Math.min(bal[creditor], -bal[debtor]);
    settlements.push({ from: debtor, to: creditor, amount });
    bal[creditor] -= amount;
    bal[debtor]   += amount;
  }

  let result = `💸 <b>Trip Settlement</b>\n\n`;
  result += `💰 <b>Total spent:</b> ${formatAmount(grandTotal, currency)}\n`;
  result += `➗ <b>Equal share:</b> ${formatAmount(share, currency)} per person\n\n`;

  result += `<b>What each person paid:</b>\n`;
  allMembers.sort().forEach(p => {
    result += `• ${p}: ${formatAmount(paid[p] || 0, currency)}\n`;
  });

  result += `\n<b>Transfers needed:</b>\n`;
  if (settlements.length === 0) {
    result += `✅ Everyone's even — nothing to settle!`;
  } else {
    settlements.forEach(s => {
      result += `• ${s.from} → ${s.to}: ${formatAmount(s.amount, currency)}\n`;
    });
  }
  return result;
}

// =====================================================
// RECEIPT OCR — Gemini Vision extracts expense from a photo
// =====================================================
function handleReceiptPhoto(msg, chatId) {
  const currency = getCurrency(chatId);
  const members = getMembers(chatId);
  const senderName = msg.from.first_name || "User";
  const caption = (msg.caption || "").trim();

  sendMessage(chatId, "🔍 Scanning receipt...");

  // Use the largest available photo size
  const fileId = msg.photo[msg.photo.length - 1].file_id;
  const fileRes = UrlFetchApp.fetch(
    `${TG_API}/getFile?file_id=${encodeURIComponent(fileId)}`,
    { muteHttpExceptions: true }
  );
  const fileData = JSON.parse(fileRes.getContentText());
  if (!fileData.ok) {
    sendMessage(chatId, "⚠️ Could not retrieve photo. Please try again.");
    return;
  }

  const filePath = fileData.result.file_path;
  const imgRes = UrlFetchApp.fetch(
    `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`,
    { muteHttpExceptions: true }
  );
  const base64 = Utilities.base64Encode(imgRes.getContent());
  const mimeType = filePath.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";

  const memberList = members.join(", ");
  const captionHint = caption ? `\nCaption from user: "${caption}"` : "";
  const amountRules = currency.shorthands
    ? `Currency: ${currency.name} (${currency.code}). Return amount as a plain integer.`
    : `Currency: ${currency.name} (${currency.code}). Amount with up to ${currency.decimals} decimal places.`;

  const prompt = `You are a receipt scanner for a group expense tracker.
Analyze this receipt image and extract the total expense.
${amountRules}
Trip members (valid payer names): ${memberList}${captionHint}

If the caption names a trip member, use them as paidBy. Otherwise use: "${senderName}".

Return ONLY a raw JSON object (no markdown fences, no explanation):
{
  "type": "expense",
  "amount": <total as number>,
  "note": "<brief what the receipt is for>",
  "category": "Food | Transport | Accommodation | Activities | Shopping | Other",
  "paidBy": "<Name in Title Case>",
  "reaction": "<short friendly reply with emojis>",
  "items": ["<item>: <amount>"]
}`;

  let parsed;
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`;
    const res = UrlFetchApp.fetch(url, {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify({
        contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType, data: base64 } }] }]
      }),
      muteHttpExceptions: true,
    });
    const data = JSON.parse(res.getContentText());
    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch (err) {
    Logger.log("Receipt OCR error: " + err);
    sendMessage(chatId, "🤔 Couldn't read the receipt. Try a clearer, straighter photo.");
    return;
  }

  if (!parsed?.amount) {
    sendMessage(chatId, "🤔 No amount found on the receipt. Try a clearer photo.");
    return;
  }

  parsed.amount = Number(parsed.amount);
  appendToSheet(parsed, senderName, chatId);
  const paidByLabel = parsed.paidBy || senderName;
  let reply =
    `🧾 <b>Receipt scanned!</b>\n` +
    `✅ <b>${parsed.note || "Receipt"}</b> ${formatAmount(parsed.amount, currency)}\n` +
    `🏷️ Category: <b>${parsed.category || "Other"}</b>\n` +
    `👤 Paid by: <b>${paidByLabel}</b>`;
  if (Array.isArray(parsed.items) && parsed.items.length > 0) {
    reply += `\n\n<b>Items:</b>\n` + parsed.items.map(i => `• ${i}`).join("\n");
  }
  if (parsed.reaction) reply += `\n\n${parsed.reaction}`;
  sendChunked(chatId, reply, "HTML");
}

// =====================================================
// HISTORY — list and delete transactions by row ID
// =====================================================
function listTransactions(chatId, n) {
  const count = Math.min(Math.max(parseInt(n) || 10, 1), 50);
  const tabName = getSheetTabName(chatId);
  const currency = getCurrency(chatId);
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sh = ss.getSheetByName(tabName);
  if (!sh || sh.getLastRow() <= 1) return "📭 No transactions recorded yet.";

  const lastRow = sh.getLastRow();
  const startRow = Math.max(2, lastRow - count + 1);
  const numRows = lastRow - startRow + 1;
  const data = sh.getRange(startRow, 1, numRows, sh.getLastColumn()).getValues();

  let result = `📋 <b>Last ${numRows} transaction${numRows !== 1 ? "s" : ""}</b>\n`;
  result += `<i>Use /delete &lt;id&gt; to remove one.</i>\n\n`;

  // Show most-recent first
  for (let i = data.length - 1; i >= 0; i--) {
    const rowNum = startRow + i;
    const [ts, , type, amt, note, , paidBy] = data[i];
    const date = ts ? `${new Date(ts).getMonth() + 1}/${new Date(ts).getDate()}` : "?";
    const emoji = type?.toLowerCase() === "income" ? "💰" : "💸";
    result += `<code>#${rowNum}</code> ${emoji} [${date}] <b>${note || "?"}</b> ${formatAmount(Number(amt || 0), currency)} — ${paidBy || "?"}\n`;
  }
  return result;
}

// Deletes a row by sheet row number. Returns the deleted row array, or null if not found.
function deleteTransactionById(chatId, rowNum) {
  const tabName = getSheetTabName(chatId);
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sh = ss.getSheetByName(tabName);
  if (!sh || rowNum <= 1 || rowNum > sh.getLastRow()) return null;
  const row = sh.getRange(rowNum, 1, 1, sh.getLastColumn()).getValues()[0];
  try {
    sh.deleteRow(rowNum);
    // If the undo pointer was pointing at this row, invalidate it
    const props = PropertiesService.getScriptProperties();
    if (Number(props.getProperty(`LAST_UNDO_ROW_${chatId}`)) === rowNum) {
      props.deleteProperty(`LAST_UNDO_ROW_${chatId}`);
    }
    return row;
  } catch (err) {
    Logger.log("deleteTransactionById error: " + err);
    return null;
  }
}

// =====================================================
// TRIP LIFECYCLE — archive current tab, start fresh
// =====================================================
function startNewTrip(chatId, tripName) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const props = PropertiesService.getScriptProperties();
  const date = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyyMMdd");

  // Archive the current tab
  const oldTabName = getSheetTabName(chatId);
  const oldSheet = ss.getSheetByName(oldTabName);
  let archivedTab = `${oldTabName}_${date}`;
  if (oldSheet) {
    let suffix = 1;
    while (ss.getSheetByName(archivedTab)) archivedTab = `${oldTabName}_${date}_${suffix++}`;
    oldSheet.setName(archivedTab);
  }

  // Determine new tab name; avoid collision
  let newTab = tripName ? tripName : `Trip_${date}`;
  let cnt = 1;
  while (ss.getSheetByName(newTab)) newTab = `${tripName || "Trip_" + date}_${cnt++}`;

  // Update the cached tab name and clear stale undo pointer
  props.setProperty(`SHEET_TAB_${chatId}`, newTab);
  props.deleteProperty(`LAST_UNDO_ROW_${chatId}`);
  ensureSheet(chatId); // creates fresh tab with headers
  return { archivedTab, newTab };
}

// =====================================================
// REMINDER TOGGLE — per-chat on/off for daily jobs
// =====================================================
function isRemindersEnabled(chatId) {
  return PropertiesService.getScriptProperties().getProperty(`REMINDERS_OFF_${chatId}`) !== "true";
}

function setRemindersEnabled(chatId, enabled) {
  const props = PropertiesService.getScriptProperties();
  if (enabled) {
    props.deleteProperty(`REMINDERS_OFF_${chatId}`);
  } else {
    props.setProperty(`REMINDERS_OFF_${chatId}`, "true");
  }
}

// =====================================================
// HELPER — convert a string to Title Case
// =====================================================
function toTitleCase(str) {
  return str.replace(/\w\S*/g, txt => txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase());
}

// =====================================================
// TELEGRAM HANDLER
// =====================================================
function sendMessage(chatId, text, mode = "HTML", buttons = null) {
  const payload = { chat_id: chatId, text, parse_mode: mode };
  if (buttons) payload.reply_markup = { inline_keyboard: buttons };
  UrlFetchApp.fetch(`${TG_API}/sendMessage`, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
}

// =====================================================
// DAILY JOBS
// =====================================================
function dailyReminderJob() {
  if (!isRemindersEnabled(ADMIN_CHAT_ID)) return;
  const message = "💡 Time to log your expenses!\nHave you added today's costs? 📝";
  const buttons = [[{ text: "📅 Today by Person", callback_data: "/today" }, { text: "✈️ Trip Summary", callback_data: "/trip" }]];
  sendMessage(ADMIN_CHAT_ID, message, "Markdown", buttons);
}

function dailyReportJob() {
  if (!isRemindersEnabled(ADMIN_CHAT_ID)) return;
  const report = getTodayByPerson(ADMIN_CHAT_ID);
  sendChunked(ADMIN_CHAT_ID, "⏰ 21:00 – Daily Report:\n\n" + report, "HTML");
}

function doGet() {
  return ContentService.createTextOutput("✅ Gemini Finance Bot v1 is running normally.");
}
