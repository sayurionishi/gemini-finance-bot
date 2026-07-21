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

// Defaults applied to a chat until it overrides them with /setcurrency or
// /settimezone. DEFAULT_CURRENCY must be a key in CURRENCIES below.
const DEFAULT_CURRENCY = "NZD";
const DEFAULT_TIMEZONE = "Pacific/Auckland";

// Default member roster used when a chat hasn't set its own via /setmembers.
// Per-chat rosters take precedence — see getMembers().
const TRIP_MEMBERS = ["Sayuri", "Chloe"];

// Supported currencies — extend as needed.
// k/m shorthand ("10k" = 10,000) works for every currency; only decimals
// differ (0 for KRW/JPY, 2 for the rest).
const CURRENCIES = {
  KRW: { code: "KRW", symbol: "₩", decimals: 0, name: "Korean Won"     },
  NZD: { code: "NZD", symbol: "$", decimals: 2, name: "NZ Dollar"      },
  USD: { code: "USD", symbol: "$", decimals: 2, name: "US Dollar"      },
  AUD: { code: "AUD", symbol: "$", decimals: 2, name: "AU Dollar"      },
  PHP: { code: "PHP", symbol: "₱", decimals: 2, name: "Philippine Peso" },
  EUR: { code: "EUR", symbol: "€", decimals: 2, name: "Euro"          },
  GBP: { code: "GBP", symbol: "£", decimals: 2, name: "British Pound" },
  JPY: { code: "JPY", symbol: "¥", decimals: 0, name: "Japanese Yen"  },
};

// =====================================================
// CURRENCY HELPERS
// =====================================================

// Returns the currency config for a chat. Defaults to KRW.
function getCurrency(chatId) {
  const code = PropertiesService.getScriptProperties().getProperty(`CURRENCY_${chatId}`) || DEFAULT_CURRENCY;
  return CURRENCIES[code] || CURRENCIES[DEFAULT_CURRENCY] || CURRENCIES.KRW;
}

// Stores the currency choice for a chat. Returns false if code is unknown.
function setCurrency(chatId, code) {
  const upper = code.toUpperCase().trim();
  if (!CURRENCIES[upper]) return false;
  PropertiesService.getScriptProperties().setProperty(`CURRENCY_${chatId}`, upper);
  return true;
}

// =====================================================
// PERSONALITY HELPERS — per-chat tone & language for the
// Gemini-generated reaction on a logged transaction.
// Same opt-in pattern as currency/timezone: unset = default.
// =====================================================
const DEFAULT_TONE = "friendly";
const DEFAULT_LANGUAGE = "en";
const TONES = ["friendly", "savage"];
const LANGUAGES = { en: "English", tl: "Filipino/Taglish" };

// Returns the chat's reaction tone: "friendly" (default) or "savage".
function getTone(chatId) {
  const tone = PropertiesService.getScriptProperties().getProperty(`TONE_${chatId}`);
  return TONES.includes(tone) ? tone : DEFAULT_TONE;
}

// Stores the tone choice for a chat. Returns false if unrecognized.
function setTone(chatId, tone) {
  const lower = tone.toLowerCase().trim();
  if (!TONES.includes(lower)) return false;
  PropertiesService.getScriptProperties().setProperty(`TONE_${chatId}`, lower);
  return true;
}

// Returns the chat's reaction language: "en" (default) or "tl".
function getLanguage(chatId) {
  const lang = PropertiesService.getScriptProperties().getProperty(`LANGUAGE_${chatId}`);
  return LANGUAGES[lang] ? lang : DEFAULT_LANGUAGE;
}

// Stores the language choice for a chat. Returns false if unrecognized.
function setLanguage(chatId, lang) {
  const lower = lang.toLowerCase().trim();
  if (!LANGUAGES[lower]) return false;
  PropertiesService.getScriptProperties().setProperty(`LANGUAGE_${chatId}`, lower);
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

function sanitizeTabName(name) {
  return name.replace(/[:\\/?*\[\]]/g, " ").replace(/\s+/g, " ").trim().substring(0, 100);
}

// Fetches the chat title from Telegram (group name, or first+last name for DMs).
function getChatTitle(chatId) {
  try {
    const res = UrlFetchApp.fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/getChat?chat_id=${chatId}`,
      { muteHttpExceptions: true }
    );
    const data = JSON.parse(res.getContentText());
    if (data.ok) {
      const c = data.result;
      return c.title || [c.first_name, c.last_name].filter(Boolean).join(" ") || null;
    }
  } catch (e) {}
  return null;
}

// Derives a unique, valid tab name from a chat title. Falls back to the raw
// chatId when the title is missing or sanitizes to empty, and appends the
// chatId when another chat already uses the same name.
function computeTabName(title, chatId, usedNames) {
  const sanitized = title ? sanitizeTabName(title) : "";
  if (!sanitized) return String(chatId);
  return usedNames.has(sanitized)
    ? sanitized.substring(0, 90) + ` (${chatId})`
    : sanitized;
}

// Returns the sheet tab name for this chatId.
// Tab names are derived from the Telegram chat title so tabs are human-readable.
// The first chatId claims the legacy "Transactions" tab to preserve existing data.
// All mutations run inside a LockService lock so concurrent webhooks for the
// same chat can't both claim "Transactions" or both rename a numeric tab.
function getSheetTabName(chatId) {
  const props = PropertiesService.getScriptProperties();
  const key = `SHEET_TAB_${chatId}`;
  const cached = props.getProperty(key);
  // Fast path: a non-numeric (already-upgraded) name needs no further work.
  if (cached && !/^-?\d+$/.test(cached)) return cached;

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
    // Re-read inside the lock — another invocation may have changed it.
    const current = props.getProperty(key);
    const allProps = props.getProperties();
    const usedNames = new Set(
      Object.entries(allProps)
        .filter(([k]) => k.startsWith("SHEET_TAB_") && k !== key)
        .map(([, v]) => v)
    );

    // Auto-upgrade an old numeric tab name (raw chatId) to the chat title.
    if (current && /^-?\d+$/.test(current)) {
      const title = getChatTitle(chatId);
      if (!title) return current; // keep numeric name; retry on a later message
      const newName = computeTabName(title, chatId, usedNames);
      if (newName === current) return current;
      try {
        const ss = SpreadsheetApp.openById(SHEET_ID);
        const sh = ss.getSheetByName(current);
        if (sh) sh.setName(newName);
        props.setProperty(key, newName);
        return newName;
      } catch (e) {
        return current;
      }
    }
    if (current) return current;

    // First time we've seen this chat: claim the legacy tab or create a new one.
    const ss = SpreadsheetApp.openById(SHEET_ID);
    const transTab = ss.getSheetByName("Transactions");
    const alreadyClaimed = usedNames.has("Transactions");
    const tabName = (transTab && !alreadyClaimed)
      ? "Transactions"
      : computeTabName(getChatTitle(chatId), chatId, usedNames);
    props.setProperty(key, tabName);
    return tabName;
  } finally {
    lock.releaseLock();
  }
}

// =====================================================
// WEBHOOK SETUP — run once from the Apps Script editor after deploy.
// Re-registers the webhook and opts into my_chat_member updates so the
// bot fires the welcome message when added to a group.
//
// IMPORTANT: Telegram must call the published /exec web-app URL, not the
// /dev (head) URL. ScriptApp.getService().getUrl() can return the /dev URL
// depending on how the script is run, so pass the /exec URL explicitly:
//   setup("https://script.google.com/macros/s/AKfy.../exec")
// Run with no argument only if you've confirmed getUrl() returns /exec.
// =====================================================
function setup(webhookUrl) {
  webhookUrl = webhookUrl || ScriptApp.getService().getUrl();
  if (!webhookUrl || webhookUrl.indexOf("/exec") === -1) {
    Logger.log("⚠️ Refusing to register a non-/exec URL: " + webhookUrl +
      "\nPass the published /exec URL explicitly: setup('https://.../exec')");
    return;
  }
  const res = UrlFetchApp.fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`,
    {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify({
        url: webhookUrl,
        allowed_updates: ["message", "callback_query", "my_chat_member"],
      }),
    }
  );
  Logger.log("Registered webhook: " + webhookUrl + "\nsetWebhook response: " + res.getContentText());
}

// =====================================================
// WEBHOOK ENTRY POINT
// =====================================================
function doPost(e) {
  try {
    const update = JSON.parse(e.postData.contents);

    // Bot added to a chat — my_chat_member is the reliable signal for this in
    // modern Telegram groups/supergroups. Only welcome on a genuine join
    // transition (was absent → now present); ignore promotions/demotions and
    // the bot leaving, so we don't re-send the guide on every status change.
    if (update.my_chat_member) {
      const mc = update.my_chat_member;
      const oldStatus = mc.old_chat_member?.status;
      const newStatus = mc.new_chat_member?.status;
      const wasAbsent = !oldStatus || oldStatus === "left" || oldStatus === "kicked";
      const nowPresent = newStatus === "member" || newStatus === "administrator";
      if (wasAbsent && nowPresent) {
        const chatId = mc.chat.id;
        ensureSheet(chatId);
        sendWelcome(chatId, mc.from?.first_name || "");
      }
      return HtmlService.createHtmlOutput("ok");
    }

    // Normalize callback_query (inline button tap) into a message-like object
    // so the rest of the routing handles it identically to a typed command.
    let msg = update.message;
    if (!msg && update.callback_query) {
      const cb = update.callback_query;
      answerCallbackQuery(cb.id); // dismiss the button spinner immediately
      msg = {
        from: cb.from,
        chat: cb.message?.chat || { id: cb.from.id },
        text: cb.data,
      };
    }

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
    const tone = getTone(chatId);
    const language = getLanguage(chatId);

    // =====================================================
    // BASIC COMMANDS
    // =====================================================
    if (command === "/start") {
      ensureSheet(chatId);
      sendWelcome(chatId, msg.from.first_name);
      return HtmlService.createHtmlOutput("ok");
    }

    if (command === "/help") {
      ensureSheet(chatId);
      const supported = Object.keys(CURRENCIES).join(", ");
      const helpText =
        "👋 Hello <b>" + escapeHtml(msg.from.first_name || "there") + "!</b>\n\n" +
        "I'm <b>Gemini Finance Bot</b> 💰 – your expense tracker.\n\n" +
        "🧾 Log expenses naturally:\n" +
        "• <code>lunch 10k sayuri</code> (k = ×1,000, any currency)\n" +
        "• <code>coffee 5.50 - chloe</code> (decimals where supported)\n" +
        "• Multi-line: send several transactions at once\n" +
        "• 📷 Send a receipt photo to scan it automatically!\n\n" +
        "📊 Report commands:\n" +
        "• <code>/report</code> – Overall report\n" +
        "• <code>/reportday</code> – Today's report\n" +
        "• <code>/reportmonth</code> – Monthly report\n" +
        "• <code>/reportcategory</code> – Report by category\n" +
        "• <code>/topcategory</code> – Top spending category\n\n" +
        "✈️ Trip commands:\n" +
        "• <code>/trip</code> – Full trip summary per person\n" +
        "• <code>/today</code> – Today's expenses by person\n" +
        "• <code>/person &lt;name&gt;</code> – All transactions by a person\n" +
        "• <code>/settle</code> – Settlement: who pays whom\n" +
        "• <code>/settle Chloe paid Sayuri 50 [for dinner]</code> – Record a repayment\n" +
        "• <code>/summary</code> – Trip summary + settlement in one recap\n\n" +
        "📋 History:\n" +
        "• <code>/list</code> – Last 10 transactions with IDs\n" +
        "• <code>/list 20</code> – Last 20 transactions\n" +
        "• <code>/delete &lt;id&gt;</code> – Delete transaction by ID\n" +
        "• <code>/edit &lt;id&gt; &lt;field&gt; &lt;value&gt;</code> – Edit a transaction\n" +
        "• <code>/search &lt;keyword&gt;</code> – Search transactions\n\n" +
        "🗂️ Trip lifecycle:\n" +
        "• <code>/newtrip [name]</code> – Archive current trip, start fresh\n\n" +
        "🛠️ Settings &amp; other:\n" +
        "• <code>/setmembers &lt;names&gt;</code> – Set trip members for this chat\n" +
        "• <code>/setcurrency &lt;code&gt;</code> – Set currency (" + escapeHtml(supported) + ")\n" +
        "• <code>/settimezone &lt;tz&gt;</code> – Set timezone (e.g. Asia/Seoul)\n" +
        "• <code>/settone friendly|savage</code> – Set reaction tone (savage = playful roast) 🔥\n" +
        "• <code>/setlanguage en|tl</code> – Set reaction language (tl = Filipino/Taglish) 🇵🇭\n" +
        "• <code>/reminders on/off</code> – Toggle daily reminders\n" +
        "• <code>/undo</code> – Undo last transaction\n" +
        "• <code>/confirm</code> – Confirm deletion\n" +
        "• <code>/whoami</code> – Chat ID, currency, tab, timezone, tone, language &amp; members\n\n" +
        "⏰ Daily reminder at " + REMIND_HOUR + ":00, report at " + REPORT_HOUR + ":00.\n\n" +
        "💱 Current currency: <b>" + currency.code + "</b> (" + currency.symbol + ")\n" +
        "🎭 Current tone: <b>" + toTitleCase(tone) + "</b> · 🌐 Language: <b>" + LANGUAGES[language] + "</b>";
      sendMessage(chatId, helpText, "HTML");
      return HtmlService.createHtmlOutput("ok");
    }

    if (command === "/whoami") {
      const tabName = getSheetTabName(chatId);
      const members = getMembers(chatId);
      const memberLabel = hasCustomMembers(chatId) ? "" : " <i>(default)</i>";
      const tz = getTimezone(chatId);
      sendMessage(chatId,
        `🪪 <b>Chat ID:</b> <code>${chatId}</code>\n` +
        `💱 <b>Currency:</b> ${currency.code} (${currency.symbol})\n` +
        `📋 <b>Sheet tab:</b> ${escapeHtml(tabName)}\n` +
        `👥 <b>Members:</b> ${escapeHtml(members.join(", "))}${memberLabel}\n` +
        `🕐 <b>Timezone:</b> ${escapeHtml(tz)}\n` +
        `🎭 <b>Tone:</b> ${toTitleCase(tone)}\n` +
        `🌐 <b>Language:</b> ${LANGUAGES[language]}`,
        "HTML");
      return HtmlService.createHtmlOutput("ok");
    }

    // /setmembers Sayuri Chloe Alex  (or comma-separated)
    if (commandBase === "/setmembers") {
      if (!args) {
        const current = getMembers(chatId);
        const label = hasCustomMembers(chatId) ? "" : " <i>(default)</i>";
        sendMessage(chatId,
          `👥 <b>Current members:</b> ${escapeHtml(current.join(", "))}${label}\n\n` +
          `Set new list (use commas to separate names):\n` +
          `<code>/setmembers Sayuri, Chloe</code>\n` +
          `<code>/setmembers Sayuri, Kristel Chloe</code> <i>(multi-word name)</i>`,
          "HTML");
        return HtmlService.createHtmlOutput("ok");
      }
      // Accept comma- or space-separated input; title-case each name
      const rawNames = args.includes(',') ? args.split(',') : args.split(/\s+/);
      const names = rawNames.map(s => toTitleCase(s.trim())).filter(Boolean);
      if (setMembers(chatId, names)) {
        const commaHint = !args.includes(',')
          ? `\n\n💡 <i>Tip: If any name has multiple words (e.g. "Kristel Chloe"), use commas:\n<code>/setmembers ${escapeHtml(names.join(', '))}</code></i>`
          : "";
        sendMessage(chatId,
          `✅ Members set to: <b>${escapeHtml(names.join(", "))}</b>\n\n` +
          `Future transactions will recognize these names. ` +
          `Existing data is untouched — old payers still appear in /settle.` +
          commaHint,
          "HTML");
      } else {
        sendMessage(chatId, `⚠️ Please provide at least one name.\nExample: <code>/setmembers Sayuri, Chloe</code>`, "HTML");
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

    // /settimezone Asia/Seoul
    if (commandBase === "/settimezone") {
      const tz = args.split(/\s+/)[0] || "";
      if (!tz) {
        const current = getTimezone(chatId);
        sendMessage(chatId,
          `🕐 <b>Current timezone:</b> <code>${escapeHtml(current)}</code>\n\n` +
          `Set a new timezone:\n<code>/settimezone Asia/Seoul</code>\n` +
          `<code>/settimezone Pacific/Auckland</code>\n\n` +
          `Uses IANA timezone IDs (e.g. America/New_York, Europe/London).`,
          "HTML");
        return HtmlService.createHtmlOutput("ok");
      }
      if (setTimezone(chatId, tz)) {
        const nowStr = Utilities.formatDate(new Date(), tz, "yyyy-MM-dd HH:mm");
        sendMessage(chatId,
          `✅ Timezone set to <b>${escapeHtml(tz)}</b>\n` +
          `Current time there: <code>${nowStr}</code>\n\n` +
          `/today and date-based reports now use this timezone.`,
          "HTML");
      } else {
        sendMessage(chatId,
          `⚠️ Unknown timezone: <code>${escapeHtml(tz)}</code>\n\n` +
          `Use IANA timezone IDs. Examples:\n` +
          `<code>Asia/Seoul</code> · <code>Pacific/Auckland</code> · <code>America/New_York</code>`,
          "HTML");
      }
      return HtmlService.createHtmlOutput("ok");
    }

    // /settone savage  (or "friendly")
    if (commandBase === "/settone") {
      const choice = (args.split(/\s+/)[0] || "").toLowerCase();
      if (!choice) {
        sendMessage(chatId,
          `🎭 <b>Current tone:</b> ${toTitleCase(tone)}\n\n` +
          `Set a new tone:\n` +
          `<code>/settone friendly</code> – warm, encouraging reactions\n` +
          `<code>/settone savage</code> – playful roast reactions 🔥 (Taglish-friendly, all in good fun)`,
          "HTML");
        return HtmlService.createHtmlOutput("ok");
      }
      if (setTone(chatId, choice)) {
        const newTone = getTone(chatId);
        sendMessage(chatId,
          newTone === "savage"
            ? `🔥 Tone set to <b>Savage</b>. Your wallet's about to get roasted.`
            : `😊 Tone set to <b>Friendly</b>.`,
          "HTML");
      } else {
        sendMessage(chatId, `⚠️ Unknown tone.\nSupported: <b>${TONES.join(", ")}</b>`, "HTML");
      }
      return HtmlService.createHtmlOutput("ok");
    }

    // /setlanguage tl  (or "en")
    if (commandBase === "/setlanguage") {
      const choice = (args.split(/\s+/)[0] || "").toLowerCase();
      if (!choice) {
        sendMessage(chatId,
          `🌐 <b>Current language:</b> ${LANGUAGES[language]}\n\n` +
          `Set a new language for reactions:\n` +
          `<code>/setlanguage en</code> – English\n` +
          `<code>/setlanguage tl</code> – Filipino/Taglish`,
          "HTML");
        return HtmlService.createHtmlOutput("ok");
      }
      if (setLanguage(chatId, choice)) {
        sendMessage(chatId, `✅ Reaction language set to <b>${LANGUAGES[getLanguage(chatId)]}</b>.`, "HTML");
      } else {
        sendMessage(chatId, `⚠️ Unknown language.\nSupported: <b>${Object.keys(LANGUAGES).join(", ")}</b>`, "HTML");
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
      const name = args ? toTitleCase(args) : "";
      sendChunked(chatId, getPersonTransactions(name, chatId), "HTML");
      return HtmlService.createHtmlOutput("ok");
    }

    if (commandBase === "/settle") {
      // With args: record a repayment, e.g. "/settle Chloe paid Sayuri 50"
      // or "/settle Chloe paid Sayuri 50 for dinner" (optional comment).
      // Split on " paid " to separate the two names; the FIRST numeric token
      // on the right is the amount, so multi-word names ("Kristel Chloe")
      // stay intact and anything after the amount becomes the comment.
      if (args) {
        const roster = getMembers(chatId);
        const rp = parseRepayment(args, roster);
        if (rp.error === "nomatch") {
          sendMessage(chatId,
            "⚠️ Usage: <code>/settle &lt;from&gt; paid &lt;to&gt; &lt;amount&gt; [comment]</code>\n\n" +
            "Examples:\n<code>/settle Chloe paid Sayuri 50</code>\n" +
            "<code>/settle Chloe paid Sayuri 50 for dinner</code>\n\n" +
            "Or send <code>/settle</code> alone to see who owes whom.", "HTML");
          return HtmlService.createHtmlOutput("ok");
        }
        if (rp.error === "notmember") {
          sendMessage(chatId,
            `⚠️ "<b>${escapeHtml(rp.bad)}</b>" isn't a trip member.\n` +
            `Members: ${escapeHtml(roster.join(", "))}\n\n` +
            `Add them with <code>/setmembers</code> first.`, "HTML");
          return HtmlService.createHtmlOutput("ok");
        }
        if (rp.error === "same") {
          sendMessage(chatId, "⚠️ A repayment needs two different people.", "HTML");
          return HtmlService.createHtmlOutput("ok");
        }
        recordRepayment(chatId, rp.from, rp.to, rp.amount, rp.comment);
        sendMessage(chatId,
          `✅ Recorded repayment:\n<b>${escapeHtml(rp.from)}</b> → <b>${escapeHtml(rp.to)}</b> ${formatAmount(rp.amount, currency)}` +
          (rp.comment ? `\n💬 ${escapeHtml(rp.comment)}` : "") +
          `\n\nSend /settle to see the updated balance.`, "HTML");
        return HtmlService.createHtmlOutput("ok");
      }
      sendChunked(chatId, getSettlement(chatId), "HTML");
      return HtmlService.createHtmlOutput("ok");
    }

    // /summary — trip + settlement in one recap, for wrapping up a trip
    if (command === "/summary") {
      const tripPart = getTripSummary(chatId);
      // Both helpers return the same "📭 no data" message when the sheet is
      // empty — show it once instead of duplicating with a separator.
      const summary = tripPart.startsWith("📭")
        ? tripPart
        : `${tripPart}\n\n———\n\n${getSettlement(chatId)}`;
      sendChunked(chatId, summary, "HTML");
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
        const [, user, type, amt, note, , paidBy] = deleted;
        // Repayment rows: User = from, PaidBy = to, Note = optional comment
        const line = String(type).toLowerCase() === "repayment"
          ? `• 🔄 <b>${escapeHtml(user || "?")} → ${escapeHtml(paidBy || "?")}</b> ${formatAmount(Number(amt || 0), currency)}` +
            (note ? ` <i>(${escapeHtml(note)})</i>` : "")
          : `• <b>${escapeHtml(note || "?")}</b> ${formatAmount(Number(amt || 0), currency)}\n` +
            `• Paid by: ${escapeHtml(paidBy || "?")}`;
        sendMessage(chatId, `🗑️ Deleted <code>#${rowNum}</code>:\n${line}`, "HTML");
      }
      return HtmlService.createHtmlOutput("ok");
    }

    // /edit <id> <field> <value>
    if (commandBase === "/edit") {
      const parts = args.split(/\s+/);
      const rowNum = parseInt(parts[0]);
      const field = (parts[1] || "").toLowerCase();
      const value = parts.slice(2).join(" ").trim();
      if (!rowNum || !field || !value) {
        sendMessage(chatId,
          "⚠️ Usage: <code>/edit &lt;id&gt; &lt;field&gt; &lt;value&gt;</code>\n\n" +
          "Fields: <code>note</code>, <code>amount</code>, <code>payer</code>, <code>category</code>\n\n" +
          "Examples:\n" +
          "<code>/edit 15 amount 12000</code>\n" +
          "<code>/edit 15 note taxi to airport</code>\n" +
          "<code>/edit 15 payer Chloe</code>\n" +
          "<code>/edit 15 category Transport</code>\n\n" +
          "Use /list to find the transaction ID.", "HTML");
        return HtmlService.createHtmlOutput("ok");
      }
      const result = editTransaction(chatId, rowNum, field, value, currency);
      if (result.error === "notfound") {
        sendMessage(chatId, `⚠️ Transaction <code>#${rowNum}</code> not found. Use /list to see valid IDs.`, "HTML");
      } else if (result.error === "badfield") {
        sendMessage(chatId, `⚠️ Unknown field "<b>${escapeHtml(field)}</b>".\nValid: <code>note</code>, <code>amount</code>, <code>payer</code>, <code>category</code>`, "HTML");
      } else if (result.error === "badamount") {
        sendMessage(chatId, "⚠️ Invalid amount — please provide a number.", "HTML");
      } else if (result.error === "badcategory") {
        sendMessage(chatId, "⚠️ Invalid category.\nOptions: Food, Transport, Accommodation, Activities, Shopping, Other", "HTML");
      } else if (result.error === "repayment") {
        sendMessage(chatId,
          `⚠️ <code>#${rowNum}</code> is a repayment — only <code>note</code> and <code>amount</code> can be edited.\n` +
          `To change who paid whom, <code>/delete ${rowNum}</code> and re-record with /settle.`, "HTML");
      } else {
        sendMessage(chatId, `✅ Transaction <code>#${rowNum}</code> updated: <b>${escapeHtml(field)}</b> → ${escapeHtml(result.display)}`, "HTML");
      }
      return HtmlService.createHtmlOutput("ok");
    }

    // /search <keyword>
    if (commandBase === "/search") {
      if (!args) {
        sendMessage(chatId, "⚠️ Please provide a keyword.\nExample: <code>/search coffee</code>", "HTML");
        return HtmlService.createHtmlOutput("ok");
      }
      sendChunked(chatId, searchTransactions(chatId, args), "HTML");
      return HtmlService.createHtmlOutput("ok");
    }

    // =====================================================
    // TRIP LIFECYCLE
    // =====================================================

    // /newtrip [name] — archive current tab, start fresh
    if (commandBase === "/newtrip") {
      const tripName = args ? args.substring(0, 30) : "";
      const result = startNewTrip(chatId, tripName);
      const archivedLine = result.archivedTab
        ? `📦 Old data archived: <code>${escapeHtml(result.archivedTab)}</code>\n`
        : "";
      sendMessage(chatId,
        `🗂️ <b>New trip started!</b>\n\n` +
        archivedLine +
        `✨ New tab: <code>${escapeHtml(result.newTab)}</code>\n\n` +
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
      const tz = getTimezone(chatId);
      // Repayment rows: User = from, PaidBy = to, Note = optional comment —
      // describe them as a transfer so the user confirms the right thing.
      const body = String(last.type).toLowerCase() === "repayment"
        ? `🔄 Repayment: <b>${escapeHtml(last.user || "?")} → ${escapeHtml(last.paidBy || "?")}</b> ${formatAmount(last.amount, currency)}` +
          (last.note ? `\n💬 ${escapeHtml(last.note)}` : "")
        : `💬 ${escapeHtml(last.note)}\n` +
          `💸 ${last.type} ${formatAmount(last.amount, currency)} (${last.category || "Uncategorized"})\n` +
          `👤 Paid by: ${escapeHtml(last.paidBy || "Unknown")}`;
      const confirmText =
        `❗ <b>Last transaction:</b>\n` +
        `📅 ${Utilities.formatDate(new Date(last.date), tz, "EEE, d MMM yyyy HH:mm")}\n` +
        `${body}\n\n` +
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
    const isGroup = chatId < 0;

    // In group chats, skip Gemini entirely when the message has no digits —
    // all transactions need an amount, so normal conversation never needs parsing.
    // In DM chats we still attempt parsing so the user gets helpful feedback.
    if (isGroup && !/\d/.test(text)) return HtmlService.createHtmlOutput("no text");

    const lines = text.split("\n").map(l => l.trim()).filter(l => l.length > 0);
    if (lines.length > 1) {
      // Multi-line: parse each line, collect successes and failures
      const successes = [];
      const failures = [];
      for (const line of lines) {
        // "Chloe paid Sayuri 50" between two roster members is a repayment —
        // intercept it before Gemini books it as an expense that inflates the pot.
        const rpLine = parseRepayment(line, members);
        if (!rpLine.error) {
          recordRepayment(chatId, rpLine.from, rpLine.to, rpLine.amount, rpLine.comment);
          successes.push({ type: "repayment", amount: rpLine.amount, note: `${rpLine.from} → ${rpLine.to}`, paidBy: rpLine.from });
          continue;
        }
        const p = parseAndReactWithGemini(line, senderName, currency, members, tone, language);
        if (p?.amount != null) p.amount = Number(p.amount);
        if (!p?.amount || !p?.type) {
          failures.push(line);
        } else {
          appendToSheet(p, senderName, chatId);
          successes.push(p);
        }
      }
      if (successes.length === 0) {
        if (!isGroup) {
          sendMessage(chatId,
            "🤔 I couldn't understand any of those lines. Could you rephrase?\n\n" +
            "Example:\n<code>coffee 10k sayuri\nbread 2k chloe</code>", "HTML");
        }
        return HtmlService.createHtmlOutput("unclear");
      }
      const rows = successes.map(p => {
        if (p.type === "repayment") {
          return `• 🔄 <b>${escapeHtml(p.note)}</b> ${formatAmount(p.amount, currency)}`;
        }
        const paidByLabel = p.paidBy || senderName;
        return `• <b>${escapeHtml(p.note || p.type)}</b> ${formatAmount(p.amount, currency)} — ${escapeHtml(paidByLabel)}`;
      });
      let reply = `✅ Recorded ${successes.length} transaction${successes.length > 1 ? "s" : ""}:\n` + rows.join("\n");
      if (failures.length > 0) {
        reply += `\n\n⚠️ Couldn't parse:\n` + failures.map(f => `• ${escapeHtml(f)}`).join("\n");
      }
      sendChunked(chatId, reply, "HTML");
      return HtmlService.createHtmlOutput("ok");
    }

    // Single-line: "Chloe paid Sayuri 50 [comment]" between two roster members
    // is a repayment — record it as such instead of letting Gemini book it as
    // an expense (its prompt explicitly treats "X paid ..." as an expense).
    const rp = parseRepayment(text, members);
    if (!rp.error) {
      recordRepayment(chatId, rp.from, rp.to, rp.amount, rp.comment);
      sendMessage(chatId,
        `🔄 Recorded repayment: <b>${escapeHtml(rp.from)}</b> → <b>${escapeHtml(rp.to)}</b> ${formatAmount(rp.amount, currency)}` +
        (rp.comment ? `\n💬 ${escapeHtml(rp.comment)}` : "") +
        `\n\nSend /settle to see the updated balance. Not a repayment? /undo to remove it.`, "HTML");
      return HtmlService.createHtmlOutput("ok");
    }

    // Single-line (original flow)
    const parsed = parseAndReactWithGemini(text, senderName, currency, members, tone, language);
    // Gemini sometimes returns amounts as strings — coerce early so formatAmount works correctly
    if (parsed?.amount != null) parsed.amount = Number(parsed.amount);
    if (!parsed?.amount || !parsed?.type) {
      if (!isGroup) {
        sendMessage(chatId,
          "🤔 I couldn't quite understand that transaction. Could you rephrase?\n\n" +
          "Example: <code>lunch 10k sayuri</code> or <code>coffee 5.50 - chloe</code>", "HTML");
      }
      return HtmlService.createHtmlOutput("unclear");
    }

    appendToSheet(parsed, senderName, chatId);
    const paidByLabel = parsed.paidBy || senderName;
    const reply =
      `✅ Recorded: <b>${escapeHtml(parsed.type)}</b> ${formatAmount(parsed.amount, currency)} — ${escapeHtml(parsed.note || "")}\n` +
      `🏷️ Category: <b>${escapeHtml(parsed.category || "Other")}</b>\n` +
      `👤 Paid by: <b>${escapeHtml(paidByLabel)}</b>\n\n${escapeHtml(parsed.reaction || "")}`;
    sendMessage(chatId, reply, "HTML");
    return HtmlService.createHtmlOutput("ok");

  } catch (err) {
    Logger.log("Error: " + err);
    return HtmlService.createHtmlOutput("error");
  }
}

// Builds the "reaction" instructions block shared by parseAndReactWithGemini
// and handleReceiptPhoto, based on the chat's tone (friendly/savage) and
// language (en/tl) settings. Savage stays a *playful* roast of the purchase —
// never a genuine insult of the person or any protected trait. Mild swearing
// is allowed for flavor (that's the "mumu"-style Taglish roast this is
// modeled on) but never slurs or hate speech.
function buildReactionRules(tone, language) {
  const toneRule = tone === "savage"
    ? `Style: SAVAGE ROAST. React like a sassy, savage best friend playfully roasting this ` +
      `purchase — exaggerated, sarcastic, dramatic (e.g. "Tangina, 1000 pesos para sa ` +
      `carwash?? May hand and foot spa ba yan?"). Mild swearing/curse words are fine for ` +
      `flavor (e.g. "tangina", "putangina", "punyeta" in Taglish, or "damn"/"hell" in ` +
      `English) — that's part of the fun. Tease the spending choice, the price, or the ` +
      `frequency — NEVER the person themselves or any protected trait (appearance, race, ` +
      `gender, etc.), and never slurs or hate speech. It should read as loving banter ` +
      `between close friends, not an actual insult.`
    : `Style: FRIENDLY. React like a warm, supportive friend — encouraging and lighthearted.`;
  const languageRule = language === "tl"
    ? `Language: Filipino/Taglish — a natural casual mix of Tagalog and English, the way ` +
      `friends actually text each other.`
    : `Language: English.`;
  return `- ${toneRule}\n- ${languageRule}\n- Keep it to 1-2 sentences with emojis.`;
}

// =====================================================
// GEMINI PARSER — extracts amount, type, category,
// paidBy name, and a friendly reaction emoji string.
// Amount rules adapt to the chat's configured currency.
// =====================================================
function parseAndReactWithGemini(text, userName, currency, members, tone, language) {
  try {
    const memberList = members.join(", ");
    const decimalRule = currency.decimals === 0
      ? `Currency is ${currency.name} (${currency.code}). Return amount as a plain integer.`
      : `Currency is ${currency.name} (${currency.code}). Return amount as a number with up to ${currency.decimals} decimal places (e.g. 5.50).`;
    const amountRules =
      `- "10k" means 10,000, "1.5k" means 1,500, "10m" means 10,000,000 (any currency)\n- ${decimalRule}`;
    const reactionRules = buildReactionRules(tone, language);

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

Reaction rules (the "reaction" field below):
${reactionRules}

Return ONLY a raw JSON object — no markdown fences, no explanation:
{
  "type": "expense" or "income",
  "amount": number,
  "note": "short description of what was purchased",
  "category": "Food | Transport | Accommodation | Activities | Shopping | Other",
  "paidBy": "Name in Title Case",
  "reaction": "the reaction text, following the reaction rules above"
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

  const tz = getTimezone(chatId);
  const todayDate = Utilities.formatDate(new Date(), tz, "yyyy-MM-dd");
  const thisMonth = todayDate.substring(0, 7);
  let income = 0, expense = 0;

  for (let i = 1; i < data.length; i++) {
    const [ts, , type, amt] = data[i];
    if (!ts || !type || !amt) continue;
    const rowDate = Utilities.formatDate(new Date(ts), tz, "yyyy-MM-dd");
    if (mode === "day"   && rowDate !== todayDate) continue;
    if (mode === "month" && rowDate.substring(0, 7) !== thisMonth) continue;
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
  entries.forEach(([cat, val]) => result += `• ${escapeHtml(cat)}: ${formatAmount(val, currency)}\n`);
  return result;
}

function getTopCategoryReport(chatId) {
  const tabName = getSheetTabName(chatId);
  const currency = getCurrency(chatId);
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sh = ss.getSheetByName(tabName);
  if (!sh || sh.getLastRow() <= 1) return "📭 No expense data yet.";

  const tz = getTimezone(chatId);
  const thisMonth = Utilities.formatDate(new Date(), tz, "yyyy-MM");
  const data = sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues();
  const totals = {};

  data.forEach(row => {
    const [ts, , type, amt, , category] = row;
    if (!ts) return;
    const rowMonth = Utilities.formatDate(new Date(ts), tz, "yyyy-MM");
    if (type.toLowerCase() === "expense" && rowMonth === thisMonth) {
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
    `🥇 <b>${escapeHtml(topCat)}</b>: ${formatAmount(topVal, currency)}\n` +
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
    result += `• ${escapeHtml(name)}: ${formatAmount(amt, currency)} ${diffLabel}\n`;
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

  const tz = getTimezone(chatId);
  const todayDate = Utilities.formatDate(new Date(), tz, "yyyy-MM-dd");
  const data = sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues();
  const byPerson = {};

  data.forEach(row => {
    const [ts, user, type, amt, note, , paidBy] = row;
    if (!ts || type.toLowerCase() !== "expense") return;
    if (Utilities.formatDate(new Date(ts), tz, "yyyy-MM-dd") !== todayDate) return;
    const name = paidBy || user || "Unknown";
    if (!byPerson[name]) byPerson[name] = [];
    byPerson[name].push({ note, amt: Number(amt || 0) });
  });

  if (Object.keys(byPerson).length === 0) return "📭 No expenses logged today yet.";

  let result = `📅 <b>Today's Expenses by Person</b>\n\n`;
  Object.entries(byPerson).sort((a, b) => a[0].localeCompare(b[0])).forEach(([name, items]) => {
    const total = items.reduce((s, i) => s + i.amt, 0);
    result += `👤 <b>${escapeHtml(name)}</b> — ${formatAmount(total, currency)}\n`;
    items.forEach(i => result += `  • ${escapeHtml(i.note)}: ${formatAmount(i.amt, currency)}\n`);
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

  const safeName = escapeHtml(name);
  if (rows.length === 0) return `📭 No expenses found for <b>${safeName}</b>.`;

  const tz = getTimezone(chatId);
  rows.sort((a, b) => a.ts - b.ts);
  let result = `👤 <b>Transactions by ${safeName}</b>\n\n`;
  rows.forEach(r => {
    const d = Utilities.formatDate(r.ts, tz, "M/d");
    result += `• [${d}] ${escapeHtml(r.note)} — ${formatAmount(r.amt, currency)} (${escapeHtml(r.category)})\n`;
  });
  result += `\n💰 <b>Total paid:</b> ${formatAmount(total, currency)}`;
  return result;
}

// =====================================================
// SETTLEMENT — equal-split across the chat's members,
// greedy algorithm to minimise number of transfers
// =====================================================
// Records a repayment between two people. Stored as its own row type so it
// never pollutes expense/income reports; only getSettlement reads it back.
// Column layout for a repayment row:
//   User = from (payer), Note = optional comment, Category = "Repayment",
//   PaidBy = to (recipient).
function recordRepayment(chatId, from, to, amount, comment) {
  const sh = ensureSheet(chatId);
  sh.appendRow([new Date(), from, "repayment", amount, comment || "", "Repayment", to]);
}

// Parses "<from> paid <to> <amount> [comment]" against the roster.
// Splits at the FIRST " paid " (so a comment containing "paid" still works)
// and treats the first numeric token after it as the amount, keeping
// multi-word names intact. Returns {from, to, amount, comment} on success,
// or {error, bad?}: "nomatch" (shape doesn't fit), "notmember" (bad = the
// unrecognized name), "same" (payer and recipient are the same person).
function parseRepayment(text, roster) {
  const m = String(text).match(/^(.*?)\s+paid\s+(.+)$/i);
  if (!m) return { error: "nomatch" };
  const fromRaw = m[1].trim();
  const rightTokens = m[2].trim().split(/\s+/);
  let amtIdx = -1, amount = NaN;
  for (let i = 0; i < rightTokens.length; i++) {
    const v = parseAmountInput(rightTokens[i]);
    if (!isNaN(v) && v > 0) { amtIdx = i; amount = v; break; }
  }
  // Need a payer name and at least one recipient token before the amount.
  if (!fromRaw || amtIdx < 1) return { error: "nomatch" };
  const toRaw = rightTokens.slice(0, amtIdx).join(" ").trim();
  const comment = rightTokens.slice(amtIdx + 1).join(" ").replace(/^for\s+/i, "").trim();
  const resolve = n => roster.find(r => r.toLowerCase() === n.toLowerCase());
  const from = resolve(fromRaw);
  const to = resolve(toRaw);
  if (!from) return { error: "notmember", bad: fromRaw };
  if (!to) return { error: "notmember", bad: toRaw };
  if (from === to) return { error: "same" };
  return { from, to, amount, comment };
}

function getSettlement(chatId) {
  const tabName = getSheetTabName(chatId);
  const currency = getCurrency(chatId);
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sh = ss.getSheetByName(tabName);
  if (!sh || sh.getLastRow() <= 1) return "📭 No trip expenses recorded yet.";

  const data = sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues();
  const paid = {};
  const repayments = [];
  let grandTotal = 0;

  data.forEach(row => {
    const [, user, type, amt, note, , paidBy] = row;
    const t = (type || "").toLowerCase();
    if (t === "repayment") {
      // User = from (payer), PaidBy = to (recipient), Note = optional comment
      repayments.push({ from: user || "Unknown", to: paidBy || "Unknown", amt: Number(amt || 0), note: note || "" });
      return;
    }
    if (t !== "expense") return;
    const name = paidBy || user || "Unknown";
    paid[name] = (paid[name] || 0) + Number(amt || 0);
    grandTotal += Number(amt || 0);
  });

  // Only bail out when there's truly nothing to show — a repayment recorded
  // before any expense (or after all expenses were deleted) should still
  // surface as an imbalance, not get swallowed by this early return.
  if (grandTotal === 0 && repayments.length === 0) return "📭 No expenses to settle.";

  // Include the chat's roster + anyone who has paid or been part of a repayment
  const allMembers = [...new Set([
    ...getMembers(chatId),
    ...Object.keys(paid),
    ...repayments.flatMap(r => [r.from, r.to]),
  ])];
  const share = grandTotal / allMembers.length;

  // balance > 0 = owed money; balance < 0 = owes money
  const balance = {};
  allMembers.forEach(p => { balance[p] = (paid[p] || 0) - share; });

  // A repayment settles debt: the payer's shortfall shrinks, the receiver's
  // surplus shrinks by the same amount.
  repayments.forEach(r => {
    if (balance[r.from] === undefined) balance[r.from] = 0;
    if (balance[r.to] === undefined) balance[r.to] = 0;
    balance[r.from] += r.amt;
    balance[r.to]   -= r.amt;
  });

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
    result += `• ${escapeHtml(p)}: ${formatAmount(paid[p] || 0, currency)}\n`;
  });

  if (repayments.length > 0) {
    result += `\n<b>Repayments already made:</b>\n`;
    repayments.forEach(r => {
      result += `• ${escapeHtml(r.from)} → ${escapeHtml(r.to)}: ${formatAmount(r.amt, currency)}` +
        (r.note ? ` <i>(${escapeHtml(r.note)})</i>` : "") + `\n`;
    });
  }

  result += `\n<b>Transfers still needed:</b>\n`;
  if (settlements.length === 0) {
    result += `✅ Everyone's even — nothing to settle!`;
  } else {
    settlements.forEach(s => {
      result += `• ${escapeHtml(s.from)} → ${escapeHtml(s.to)}: ${formatAmount(s.amount, currency)}\n`;
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
  const tone = getTone(chatId);
  const language = getLanguage(chatId);
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
  const amountRules = currency.decimals === 0
    ? `Currency: ${currency.name} (${currency.code}). Return amount as a plain integer.`
    : `Currency: ${currency.name} (${currency.code}). Amount with up to ${currency.decimals} decimal places.`;
  const reactionRules = buildReactionRules(tone, language);

  const prompt = `You are a receipt scanner for a group expense tracker.
Analyze this receipt image and extract the total expense.
${amountRules}
Trip members (valid payer names): ${memberList}${captionHint}

If the caption names a trip member, use them as paidBy. Otherwise use: "${senderName}".

Reaction rules (the "reaction" field below):
${reactionRules}

Return ONLY a raw JSON object (no markdown fences, no explanation):
{
  "type": "expense",
  "amount": <total as number>,
  "note": "<brief what the receipt is for>",
  "category": "Food | Transport | Accommodation | Activities | Shopping | Other",
  "paidBy": "<Name in Title Case>",
  "reaction": "<the reaction text, following the reaction rules above>",
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
    `✅ <b>${escapeHtml(parsed.note || "Receipt")}</b> ${formatAmount(parsed.amount, currency)}\n` +
    `🏷️ Category: <b>${escapeHtml(parsed.category || "Other")}</b>\n` +
    `👤 Paid by: <b>${escapeHtml(paidByLabel)}</b>`;
  if (Array.isArray(parsed.items) && parsed.items.length > 0) {
    reply += `\n\n<b>Items:</b>\n` + parsed.items.map(i => `• ${escapeHtml(i)}`).join("\n");
  }
  if (parsed.reaction) reply += `\n\n${escapeHtml(parsed.reaction)}`;
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

  const tz = getTimezone(chatId);
  let result = `📋 <b>Last ${numRows} transaction${numRows !== 1 ? "s" : ""}</b>\n`;
  result += `<i>Use /delete &lt;id&gt; or /edit &lt;id&gt; &lt;field&gt; &lt;value&gt; to modify.</i>\n\n`;

  // Show most-recent first
  for (let i = data.length - 1; i >= 0; i--) {
    const rowNum = startRow + i;
    const [ts, user, type, amt, note, , paidBy] = data[i];
    const date = ts ? Utilities.formatDate(new Date(ts), tz, "M/d") : "?";
    const t = type?.toLowerCase();
    if (t === "repayment") {
      // Repayment row: User = from, PaidBy = to, Note = optional comment
      result += `<code>#${rowNum}</code> 🔄 [${date}] <b>${escapeHtml(user || "?")} → ${escapeHtml(paidBy || "?")}</b> ${formatAmount(Number(amt || 0), currency)}` +
        (note ? ` <i>(${escapeHtml(note)})</i>` : "") + `\n`;
      continue;
    }
    const emoji = t === "income" ? "💰" : "💸";
    result += `<code>#${rowNum}</code> ${emoji} [${date}] <b>${escapeHtml(note || "?")}</b> ${formatAmount(Number(amt || 0), currency)} — ${escapeHtml(paidBy || "?")}\n`;
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

  // Sheets tab names can't contain : \ / ? * [ ] — strip them so a trip name
  // like "Korea: Spring" doesn't make insertSheet throw.
  const cleanName = tripName ? tripName.replace(/[:\\/?*\[\]]/g, " ").replace(/\s+/g, " ").trim() : "";

  // Determine new tab name; avoid collision
  const base = cleanName || `Trip_${date}`;
  let newTab = base;
  let cnt = 1;
  while (ss.getSheetByName(newTab)) newTab = `${base}_${cnt++}`;

  // Update the cached tab name and clear stale undo pointer
  props.setProperty(`SHEET_TAB_${chatId}`, newTab);
  props.deleteProperty(`LAST_UNDO_ROW_${chatId}`);
  ensureSheet(chatId); // creates fresh tab with headers
  return { archivedTab: oldSheet ? archivedTab : null, newTab };
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
// TIMEZONE HELPERS — per-chat IANA timezone
// =====================================================

// Returns the chat's configured timezone, or the Apps Script project default.
function getTimezone(chatId) {
  return PropertiesService.getScriptProperties().getProperty(`TIMEZONE_${chatId}`)
    || DEFAULT_TIMEZONE
    || Session.getScriptTimeZone();
}

// Validates an IANA timezone ID. Apps Script's Utilities.formatDate does NOT
// throw for unknown IDs — Java's TimeZone.getTimeZone silently returns GMT —
// so we detect that fallback: an unrecognized zone reports a +0000 offset at
// every date, while any real non-UTC zone differs at least once across the
// year (this also tolerates DST-only-GMT zones like Europe/London).
function isValidTimezone(tz) {
  // Allow IANA IDs (Region/City, optionally 3-part) plus digits, +, - in the
  // city part for zones like Etc/GMT+5 and America/Port-au-Prince.
  if (!tz || !/^(UTC|GMT|[A-Za-z]+\/[A-Za-z0-9+_-]+(\/[A-Za-z0-9+_-]+)?)$/.test(tz)) return false;
  if (tz === "UTC" || tz === "GMT") return true;
  try {
    const jan = Utilities.formatDate(new Date(Date.UTC(2025, 0, 1, 12)), tz, "Z");
    const jul = Utilities.formatDate(new Date(Date.UTC(2025, 6, 1, 12)), tz, "Z");
    return jan !== "+0000" || jul !== "+0000";
  } catch (e) {
    return false;
  }
}

// Stores a timezone after validating it. Returns false for unknown IDs.
function setTimezone(chatId, tz) {
  if (!isValidTimezone(tz)) return false;
  PropertiesService.getScriptProperties().setProperty(`TIMEZONE_${chatId}`, tz);
  return true;
}

// =====================================================
// EDIT TRANSACTION — update one field of an existing row
// Columns: 1=Timestamp 2=User 3=Type 4=Amount 5=Note 6=Category 7=PaidBy
// =====================================================
function editTransaction(chatId, rowNum, field, value, currency) {
  const tabName = getSheetTabName(chatId);
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sh = ss.getSheetByName(tabName);
  if (!sh || rowNum <= 1 || rowNum > sh.getLastRow()) return { error: "notfound" };

  // Repayment rows use a different column layout (User=from, PaidBy=to), so a
  // "payer" edit would silently change the recipient — and an unvalidated name
  // would become a phantom member in /settle's share math. Only note (comment)
  // and amount are safe to edit; anything else: delete and re-record.
  const rowType = String(sh.getRange(rowNum, 3).getValue() || "").toLowerCase();
  if (rowType === "repayment" && field !== "note" && field !== "description" && field !== "amount") {
    return { error: "repayment" };
  }

  const VALID_CATEGORIES = ["Food", "Transport", "Accommodation", "Activities", "Shopping", "Other"];
  let col, newValue, display;

  switch (field) {
    case "note":
    case "description":
      col = 5; newValue = value; display = value; break;
    case "amount": {
      const num = parseAmountInput(value);
      if (!num || isNaN(num) || num <= 0) return { error: "badamount" };
      col = 4; newValue = num; display = formatAmount(num, currency); break;
    }
    case "payer":
    case "paidby":
      col = 7; newValue = toTitleCase(value); display = newValue; break;
    case "category": {
      const cat = toTitleCase(value.split(/\s+/)[0]);
      if (!VALID_CATEGORIES.includes(cat)) return { error: "badcategory" };
      col = 6; newValue = cat; display = cat; break;
    }
    default:
      return { error: "badfield" };
  }

  try {
    sh.getRange(rowNum, col).setValue(newValue);
    return { display };
  } catch (err) {
    Logger.log("editTransaction error: " + err);
    return { error: "notfound" };
  }
}

// =====================================================
// SEARCH — find transactions by keyword across note/category/payer
// =====================================================
function searchTransactions(chatId, keyword) {
  const tabName = getSheetTabName(chatId);
  const currency = getCurrency(chatId);
  const tz = getTimezone(chatId);
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sh = ss.getSheetByName(tabName);
  if (!sh || sh.getLastRow() <= 1) return "📭 No transactions recorded yet.";

  const data = sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues();
  const q = keyword.toLowerCase();
  const matches = [];

  data.forEach((row, idx) => {
    const [ts, user, type, amt, note, category, paidBy] = row;
    if (!ts) return;
    // For repayments, User is the "from" side and only matches there make
    // them findable by payer name. For expenses/income, User is just who
    // typed the message — matching it would pull in unrelated rows and
    // inflate the expense total below, so it's excluded there.
    const isRepayment = (type || "").toLowerCase() === "repayment";
    const haystack = isRepayment ? [note, category, paidBy, user] : [note, category, paidBy];
    if (haystack.join(" ").toLowerCase().includes(q)) {
      matches.push({ rowNum: idx + 2, ts: new Date(ts), type, amt: Number(amt || 0), note, category, paidBy, user });
    }
  });

  const safeKeyword = escapeHtml(keyword);
  if (matches.length === 0) return `📭 No transactions found for "<b>${safeKeyword}</b>".`;

  const expenseTotal = matches
    .filter(m => m.type?.toLowerCase() === "expense")
    .reduce((s, m) => s + m.amt, 0);

  // Show most recent 20
  const shown = matches.slice(-20).reverse();
  let result = `🔍 <b>Results for "${safeKeyword}"</b> (${matches.length} found)\n\n`;
  shown.forEach(m => {
    const d = Utilities.formatDate(m.ts, tz, "M/d");
    const mt = m.type?.toLowerCase();
    if (mt === "repayment") {
      result += `<code>#${m.rowNum}</code> 🔄 [${d}] <b>${escapeHtml(m.user || "?")} → ${escapeHtml(m.paidBy || "?")}</b> ${formatAmount(m.amt, currency)}` +
        (m.note ? ` <i>(${escapeHtml(m.note)})</i>` : "") + `\n`;
      return;
    }
    const emoji = mt === "income" ? "💰" : "💸";
    result += `<code>#${m.rowNum}</code> ${emoji} [${d}] <b>${escapeHtml(m.note || "?")}</b> ${formatAmount(m.amt, currency)} — ${escapeHtml(m.paidBy || "?")}\n`;
  });
  if (matches.length > 20) result += `<i>…and ${matches.length - 20} earlier result${matches.length - 20 > 1 ? "s" : ""}</i>\n`;
  result += `\n💰 <b>Total expenses:</b> ${formatAmount(expenseTotal, currency)}`;
  return result;
}

// =====================================================
// HELPER — convert a string to Title Case
// =====================================================
function toTitleCase(str) {
  return str.replace(/\w\S*/g, txt => txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase());
}

// Escapes the characters Telegram's HTML parse mode treats as markup.
// Free-text fields (notes, payer names) MUST pass through this before being
// embedded in an HTML message, or "fish & chips" produces a 400 and the
// message silently fails (sendMessage uses muteHttpExceptions).
function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Parses a user-typed amount, honoring k/m shorthand ("10k" = 10,000),
// which applies to every currency. Returns NaN for invalid input.
function parseAmountInput(value) {
  const s = String(value).trim().toLowerCase().replace(/,/g, "");
  const m = s.match(/^([0-9]*\.?[0-9]+)\s*([km])?$/);
  if (!m) return NaN;
  const num = parseFloat(m[1]);
  if (!m[2]) return num;
  return num * (m[2] === "k" ? 1000 : 1000000);
}

// =====================================================
// ONBOARDING — sent on /start and when bot is added to a group
// =====================================================
function sendWelcome(chatId, adderName) {
  const props = PropertiesService.getScriptProperties();
  const currency = getCurrency(chatId);
  const members = getMembers(chatId);
  const tz = getTimezone(chatId);

  const tzSet      = props.getProperty(`TIMEZONE_${chatId}`) !== null;
  const curSet     = props.getProperty(`CURRENCY_${chatId}`) !== null;
  const membersSet = hasCustomMembers(chatId);

  const safeTz      = escapeHtml(tz);
  const safeMembers = escapeHtml(members.join(", "));

  let step = 1;
  const tzLine = tzSet
    ? `✅ Timezone: <code>${safeTz}</code>`
    : `${step++}. Set your timezone:\n   <code>/settimezone Pacific/Auckland</code>\n   <i>(e.g. Asia/Seoul, Australia/Sydney)</i>`;
  const curLine = curSet
    ? `✅ Currency: ${currency.code} (${currency.symbol})`
    : `${step++}. Set your currency:\n   <code>/setcurrency NZD</code>\n   <i>(supported: KRW, NZD, USD, AUD, PHP, EUR, GBP, JPY)</i>`;
  const membersLine = membersSet
    ? `✅ Members: ${safeMembers}`
    : `${step++}. Set trip members (use commas to separate):\n   <code>/setmembers Sayuri, Chloe</code>\n   <i>Multi-word names need commas: <code>/setmembers Sayuri, Kristel Chloe</code></i>`;

  const allDone = tzSet && curSet && membersSet;
  const greeting = adderName ? `Thanks for adding me, <b>${escapeHtml(adderName)}</b>! ` : "";

  const msg =
    `👋 ${greeting}I'm <b>Gemini Finance Bot</b> 💰\n` +
    `I track group trip expenses and calculate who owes whom.\n\n` +
    `<b>── Setup ──</b>\n\n` +
    `${tzLine}\n\n` +
    `${curLine}\n\n` +
    `${membersLine}\n\n` +
    (allDone
      ? `✨ <b>You're all set!</b>\n\n`
      : `Complete the steps above, then start tracking!\n\n`) +
    `<b>── Sending expenses ──</b>\n\n` +
    `<code>coffee 5 sayuri</code>\n` +
    `<code>lunch 25 - Kristel Chloe</code>\n` +
    `<code>hotel 150</code> <i>(payer = you)</i>\n` +
    `📷 Or send a <b>receipt photo</b> to scan it!\n\n` +
    `🎭 <i>Optional: want spicier reactions? Try <code>/settone savage</code> ` +
    `(+ <code>/setlanguage tl</code> for Filipino/Taglish roasts).</i>\n\n` +
    `Use /help to see all commands.`;

  sendMessage(chatId, msg, "HTML");
}

// =====================================================
// TELEGRAM HANDLERS
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

function answerCallbackQuery(callbackQueryId) {
  UrlFetchApp.fetch(`${TG_API}/answerCallbackQuery`, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify({ callback_query_id: callbackQueryId }),
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
