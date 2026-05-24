// =====================================================
// MIT License © 2025 Nghia Nguyen
// Adapted for group trip expense tracking (Korea Trip)
// =====================================================

// =====================================================
// CONFIGURATION
// =====================================================
const BOT_TOKEN  = 'YOUR_TELEGRAM_TOKEN';
const GEMINI_KEY = 'YOUR_GEMINI_API_KEY';
const SHEET_ID   = 'YOUR_SHEET_ID';
const TG_API     = 'https://api.telegram.org/bot' + BOT_TOKEN;
const ADMIN_CHAT_ID = 'YOUR_CHAT_ID';
const REMIND_HOUR = 20;
const REPORT_HOUR = 21;

// Names of all trip members — used for equal-split settlement.
// Include everyone even if they haven't paid anything yet.
const TRIP_MEMBERS = ["Sayuri", "Chloe", "Manam"];

// =====================================================
// WEBHOOK ENTRY POINT
// =====================================================
function doPost(e) {
  try {
    const update = JSON.parse(e.postData.contents);
    const msg = update.message;
    if (!msg || msg.from?.is_bot) return HtmlService.createHtmlOutput("ignored");

    const chatId = msg.chat.id;
    const text = msg.text?.trim();
    if (!text) return HtmlService.createHtmlOutput("no text");

    // Strip Telegram's @BotName suffix added in group chats (e.g. "/person@MyBot Sayuri")
    const cleanText = text.replace(/^(\/\w+)@\w+/, '$1');
    const command = cleanText.toLowerCase();
    const commandBase = command.split(' ')[0];
    // Args keep original casing so names like "Sayuri" aren't flattened
    const args = cleanText.substring(commandBase.length).trim();

    // =====================================================
    // BASIC COMMANDS
    // =====================================================
    if (command === "/start" || command === "/help") {
      ensureSheet();
      const helpText =
        "👋 Hello *" + (msg.from.first_name || "there") + "!*\n\n" +
        "I'm *Gemini Finance Bot* 💰 – your Korea trip expense tracker.\n\n" +
        "🧾 Log expenses naturally:\n" +
        "• `lunch 10k sayuri`\n• `breakfast 19000 - chloe`\n• `taxi 8500`\n\n" +
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
        "🛠️ Other:\n" +
        "• `/undo` – Undo last transaction\n" +
        "• `/confirm` – Confirm deletion\n" +
        "• `/whoami` – View Chat ID\n\n" +
        "⏰ Daily reminder at " + REMIND_HOUR + ":00, report at " + REPORT_HOUR + ":00.";
      sendMessage(chatId, helpText, "Markdown");
      return HtmlService.createHtmlOutput("ok");
    }

    if (command === "/whoami") {
      sendMessage(chatId, `🪪 Your Chat ID: <code>${chatId}</code>`, "HTML");
      return HtmlService.createHtmlOutput("ok");
    }

    if (["/report", "/reportday", "/reportmonth", "/reportcategory", "/topcategory"].includes(command)) {
      if (command === "/reportcategory") {
        sendMessage(chatId, getCategoryReport(), "HTML");
        return HtmlService.createHtmlOutput("ok");
      }
      if (command === "/topcategory") {
        sendMessage(chatId, getTopCategoryReport(), "HTML");
        return HtmlService.createHtmlOutput("ok");
      }
      let mode = "all";
      if (command === "/reportday") mode = "day";
      if (command === "/reportmonth") mode = "month";
      sendMessage(chatId, getFinanceReport(mode), "HTML");
      return HtmlService.createHtmlOutput("ok");
    }

    // =====================================================
    // TRIP COMMANDS
    // =====================================================
    if (command === "/trip") {
      sendMessage(chatId, getTripSummary(), "HTML");
      return HtmlService.createHtmlOutput("ok");
    }

    if (command === "/today") {
      sendMessage(chatId, getTodayByPerson(), "HTML");
      return HtmlService.createHtmlOutput("ok");
    }

    if (commandBase === "/person") {
      // Only take the first token — "/person Sayuri loves coffee" → "Sayuri"
      const name = args ? toTitleCase(args.split(/\s+/)[0]) : "";
      sendMessage(chatId, getPersonTransactions(name), "HTML");
      return HtmlService.createHtmlOutput("ok");
    }

    if (command === "/settle") {
      sendMessage(chatId, getSettlement(), "HTML");
      return HtmlService.createHtmlOutput("ok");
    }

    // =====================================================
    // UNDO + CONFIRM HANDLING
    // =====================================================
    if (command === "/undo") {
      const last = getLastTransaction();
      if (!last) {
        sendMessage(chatId, "⚠️ No recent transaction found to delete.");
        return HtmlService.createHtmlOutput("ok");
      }
      const confirmText =
        `❗ <b>Last transaction:</b>\n` +
        `📅 ${last.date}\n💬 ${last.note}\n💸 ${last.type} ₩${last.amount.toLocaleString()} (${last.category || "Uncategorized"})\n` +
        `👤 Paid by: ${last.paidBy || "Unknown"}\n\n` +
        `Reply with <b>/confirm</b> to delete this transaction.`;
      sendMessage(chatId, confirmText, "HTML");
      return HtmlService.createHtmlOutput("ok");
    }

    if (command === "/confirm") {
      const deleted = deleteLastTransaction();
      sendMessage(chatId, deleted ? "✅ Last transaction deleted!" : "⚠️ Nothing to delete.");
      return HtmlService.createHtmlOutput("ok");
    }

    // =====================================================
    // AI-BASED NATURAL TRANSACTION HANDLING
    // =====================================================
    const senderName = msg.from.first_name || "User";
    const parsed = parseAndReactWithGemini(text, senderName);
    // Gemini sometimes returns amounts as strings — coerce so .toLocaleString() formats correctly
    if (parsed?.amount != null) parsed.amount = Number(parsed.amount);
    if (!parsed?.amount || !parsed?.type) {
      sendMessage(chatId, "🤔 I couldn't quite understand that transaction. Could you rephrase?\n\nExample: <code>lunch 10k sayuri</code> or <code>taxi 8500 - chloe</code>", "HTML");
      return HtmlService.createHtmlOutput("unclear");
    }

    appendToSheet(parsed, senderName);
    const paidByLabel = parsed.paidBy || senderName;
    const reply =
      `✅ Recorded: <b>${parsed.type}</b> ₩${parsed.amount.toLocaleString()} — ${parsed.note || ""}\n` +
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
// GEMINI PARSER — extracts amount (KRW), type, category,
// paidBy name, and a friendly reaction emoji string
// =====================================================
function parseAndReactWithGemini(text, userName) {
  try {
    const memberList = TRIP_MEMBERS.join(", ");
    const prompt = `
You are a friendly group trip expense assistant tracking costs in South Korea.
Analyze the following message and extract the transaction details.

Trip members (these are the only valid payer names): ${memberList}

Amount rules:
- "10k" means 10,000 won, "1.5k" means 1,500 won, "10m" means 10,000,000 won
- Currency is Korean Won (KRW). Return the amount as a plain integer.

PaidBy rules (find the person who actually paid):
- ONLY pick a paidBy if the name matches one of the trip members above (case-insensitive)
- Name at the end of the message: "lunch 10k sayuri" → paidBy = "Sayuri"
- Name after a dash or hyphen: "coffee 5000 - chloe" → paidBy = "Chloe"
- Name before "paid": "manam paid 1350 for dinner" → paidBy = "Manam"
- Words that aren't trip-member names (places, foods, notes) are NOT payers
  e.g. "lunch 10000 in cheonan" → no name detected → paidBy = sender
- If no valid name is found, use the sender's name: "${userName}"
- Always normalize paidBy to Title Case (e.g. "sayuri" → "Sayuri")

Category options: Food, Transport, Accommodation, Activities, Shopping, Other

For trip expense tracking, type is almost always "expense".
Use "income" only if someone explicitly received money back or was reimbursed.

Return ONLY a raw JSON object with no markdown fences, no explanation:
{
  "type": "expense" or "income",
  "amount": integer in KRW,
  "note": "short description of what was purchased",
  "category": "Food | Transport | Accommodation | Activities | Shopping | Other",
  "paidBy": "Name in Title Case",
  "reaction": "short friendly trip-themed reply with emojis (1-2 sentences)"
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
// Timestamp | User | Type | Amount (KRW) | Note | Category | PaidBy
// =====================================================
function ensureSheet() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let sh = ss.getSheetByName("Transactions");
  if (!sh) {
    sh = ss.insertSheet("Transactions");
    sh.appendRow(["Timestamp", "User", "Type", "Amount (KRW)", "Note", "Category", "PaidBy"]);
    return;
  }

  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];

  if (!headers.includes("Category")) {
    sh.getRange(1, 6).setValue("Category");
  }

  // Rename USD column to KRW on existing sheets
  const usdIdx = headers.indexOf("Amount (USD)");
  if (usdIdx !== -1) {
    sh.getRange(1, usdIdx + 1).setValue("Amount (KRW)");
  }

  // Auto-add PaidBy column on first run against an existing sheet
  if (!headers.includes("PaidBy")) {
    sh.getRange(1, sh.getLastColumn() + 1).setValue("PaidBy");
  }
}

function appendToSheet(parsed, user) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sh = ss.getSheetByName("Transactions") || ss.insertSheet("Transactions");
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
// UNDO HANDLING
// =====================================================
function getLastTransaction() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sh = ss.getSheetByName("Transactions");
  if (!sh || sh.getLastRow() <= 1) return null;

  const lastRow = sh.getLastRow();
  // Read however many columns the sheet currently has
  const row = sh.getRange(lastRow, 1, 1, sh.getLastColumn()).getValues()[0];

  PropertiesService.getScriptProperties().setProperty("LAST_UNDO_ROW", lastRow);

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

function deleteLastTransaction() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sh = ss.getSheetByName("Transactions");

  const lastRow = Number(PropertiesService.getScriptProperties().getProperty("LAST_UNDO_ROW"));
  if (!lastRow || lastRow <= 1 || !sh) return false;

  try {
    sh.deleteRow(lastRow);
    PropertiesService.getScriptProperties().deleteProperty("LAST_UNDO_ROW");
    return true;
  } catch (err) {
    Logger.log("Undo deletion error: " + err);
    return false;
  }
}

// =====================================================
// REPORTING FUNCTIONS
// =====================================================
function getFinanceReport(mode = "all") {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sh = ss.getSheetByName("Transactions");
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
    if (type.toLowerCase() === "income") income += amt;
    if (type.toLowerCase() === "expense") expense += amt;
  }

  const balance = income - expense;
  const emoji = balance >= 0 ? "🟢" : "🔴";
  const title = mode === "day" ? "📅 <b>Today's Report</b>" : mode === "month" ? "🗓️ <b>This Month's Report</b>" : "📊 <b>Overall Report</b>";
  return `${title}\n\n💰 <b>Total Income:</b> ₩${income.toLocaleString()}\n💸 <b>Total Expense:</b> ₩${expense.toLocaleString()}\n${emoji} <b>Balance:</b> ₩${balance.toLocaleString()}\n\n${balance >= 0 ? "Nice job managing your money 😎" : "Spending a bit high today 😅"}`;
}

function getCategoryReport() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sh = ss.getSheetByName("Transactions");
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
  entries.forEach(([cat, val]) => result += `• ${cat}: ₩${val.toLocaleString()}\n`);
  return result;
}

function getTopCategoryReport() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sh = ss.getSheetByName("Transactions");
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

  return `📈 <b>Top Spending Category This Month</b>\n\n🥇 <b>${topCat}</b>: ₩${topVal.toLocaleString()}\nAbout ${percent}% of total expenses.\n\nKeep up the good financial habits 💪`;
}

// =====================================================
// TRIP SUMMARY — total trip spend, per-person breakdown,
// and how each person stands vs. the equal share
// =====================================================
function getTripSummary() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sh = ss.getSheetByName("Transactions");
  if (!sh || sh.getLastRow() <= 1) return "📭 No trip expenses recorded yet.";

  const data = sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues();
  const paid = {};
  let grandTotal = 0;

  data.forEach(row => {
    const [, user, type, amt, , , paidBy] = row;
    if (type.toLowerCase() !== "expense") return;
    // Fall back to User (whoever logged it) for old rows that predate the PaidBy column
    const name = paidBy || user || "Unknown";
    paid[name] = (paid[name] || 0) + Number(amt || 0);
    grandTotal += Number(amt || 0);
  });

  if (grandTotal === 0) return "📭 No expenses recorded yet.";

  // Use TRIP_MEMBERS as the baseline so everyone is included even with ₩0 paid
  const allMembers = [...new Set([...TRIP_MEMBERS, ...Object.keys(paid)])];
  const share = grandTotal / allMembers.length;

  let result = `✈️ <b>Full Trip Summary</b>\n\n`;
  result += `💰 <b>Total Spent:</b> ₩${grandTotal.toLocaleString()}\n`;
  result += `➗ <b>Equal Share:</b> ₩${Math.round(share).toLocaleString()} per person\n\n`;
  result += `<b>Paid by each person:</b>\n`;

  allMembers.sort().forEach(name => {
    const amt = paid[name] || 0;
    const diff = amt - share;
    const diffLabel = diff >= 0
      ? `<i>(+₩${Math.round(diff).toLocaleString()} over)</i>`
      : `<i>(-₩${Math.round(Math.abs(diff)).toLocaleString()} under)</i>`;
    result += `• ${name}: ₩${amt.toLocaleString()} ${diffLabel}\n`;
  });

  result += `\nUse /settle to see who pays whom.`;
  return result;
}

// =====================================================
// TODAY BY PERSON — today's expenses itemized per payer
// =====================================================
function getTodayByPerson() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sh = ss.getSheetByName("Transactions");
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
    result += `👤 <b>${name}</b> — ₩${total.toLocaleString()}\n`;
    items.forEach(i => result += `  • ${i.note}: ₩${i.amt.toLocaleString()}\n`);
    result += `\n`;
  });
  return result;
}

// =====================================================
// PERSON TRANSACTIONS — all trip expenses for one person
// =====================================================
function getPersonTransactions(name) {
  if (!name) return "⚠️ Please provide a name. Example: <code>/person Sayuri</code>";

  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sh = ss.getSheetByName("Transactions");
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
    result += `• [${dateStr}] ${r.note} — ₩${r.amt.toLocaleString()} (${r.category})\n`;
  });
  result += `\n💰 <b>Total paid:</b> ₩${total.toLocaleString()}`;
  return result;
}

// =====================================================
// SETTLEMENT — equal-split across TRIP_MEMBERS,
// greedy algorithm to minimize number of transfers
// =====================================================
function getSettlement() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sh = ss.getSheetByName("Transactions");
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

  // Include all configured members even if they paid ₩0
  const allMembers = [...new Set([...TRIP_MEMBERS, ...Object.keys(paid)])];
  const share = grandTotal / allMembers.length;

  // balance > 0 means person is owed money; balance < 0 means person owes
  const balance = {};
  allMembers.forEach(p => { balance[p] = (paid[p] || 0) - share; });

  // Greedy: repeatedly pair the biggest creditor with the biggest debtor
  const settlements = [];
  const bal = { ...balance };
  for (let iter = 0; iter < 100; iter++) {
    const creditor = allMembers.reduce((best, p) => bal[p] > (bal[best] || 0) ? p : best, allMembers[0]);
    const debtor   = allMembers.reduce((best, p) => bal[p] < (bal[best] || 0) ? p : best, allMembers[0]);
    if (bal[creditor] < 1 || bal[debtor] > -1) break;
    const amount = Math.min(bal[creditor], -bal[debtor]);
    if (amount > 1) settlements.push({ from: debtor, to: creditor, amount: Math.round(amount) });
    bal[creditor] -= amount;
    bal[debtor]   += amount;
  }

  let result = `💸 <b>Trip Settlement</b>\n\n`;
  result += `💰 <b>Total spent:</b> ₩${grandTotal.toLocaleString()}\n`;
  result += `➗ <b>Equal share:</b> ₩${Math.round(share).toLocaleString()} per person\n\n`;

  result += `<b>What each person paid:</b>\n`;
  allMembers.sort().forEach(p => {
    result += `• ${p}: ₩${Math.round(paid[p] || 0).toLocaleString()}\n`;
  });

  result += `\n<b>Transfers needed:</b>\n`;
  if (settlements.length === 0) {
    result += `✅ Everyone's even — nothing to settle!`;
  } else {
    settlements.forEach(s => {
      result += `• ${s.from} → ${s.to}: ₩${s.amount.toLocaleString()}\n`;
    });
  }
  return result;
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
  const message = "💡 Time to log your expenses!\nHave you added today's trip costs? 📝";
  const buttons = [[{ text: "📅 Today by Person", callback_data: "/today" }, { text: "✈️ Trip Summary", callback_data: "/trip" }]];
  sendMessage(ADMIN_CHAT_ID, message, "Markdown", buttons);
}

function dailyReportJob() {
  const report = getTodayByPerson();
  sendMessage(ADMIN_CHAT_ID, "⏰ 21:00 – Daily Trip Report:\n\n" + report, "HTML");
}

function doGet() {
  return ContentService.createTextOutput("✅ Gemini Finance Bot v1 is running normally.");
}
