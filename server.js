import "dotenv/config";
import express from "express";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";
import { google } from "googleapis";

const app = express();
const PORT = process.env.PORT || 3001;

const MODELS = [
  "gemini-2.5-flash-lite",
  "gemini-3.5-flash-lite",
  "gemini-3.5-flash",
  "gemini-2.0-flash-lite",
];

const DEFAULT_HEADERS = [
  "Captured At", "Startup Name", "Source URL", "Screenshot Link",
  "Founding Year", "Founders", "Founder Background", "Right to Win",
  "Funding Raised", "Valuation", "ARR / Revenue", "Key Products",
  "Investment Thesis", "Why They Stand Out", "Competitors (Startups)",
  "Competitors (Incumbents)", "Relevant Links", "Confidence / Notes", "Job Status",
];

const RESEARCH_QUERIES = (name) => [
  `"${name}" startup founders CEO background LinkedIn`,
  `"${name}" funding raised valuation investors crunchbase`,
  `"${name}" revenue ARR annual recurring revenue`,
  `"${name}" product what does company do`,
  `"${name}" competitors market landscape alternatives`,
  `"${name}" startup news investment`,
];

const jobs = new Map();

app.use(cors());
app.use(express.json({ limit: "15mb" }));

function parseGoogleCredentials() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON not set on Render");
  let text = String(raw).trim();
  if (text.startsWith('"') && text.endsWith('"')) {
    try { text = JSON.parse(text); } catch { /* keep */ }
  }
  text = String(text).trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1) throw new Error("Google JSON invalid — re-paste in Render");
  try {
    const creds = JSON.parse(text.slice(start, end + 1));
    if (!creds.client_email || !creds.private_key) throw new Error("incomplete");
    return creds;
  } catch {
    throw new Error("Google JSON broken — re-paste full .json file in Render");
  }
}

function googleJsonOk() {
  try { parseGoogleCredentials(); return true; } catch { return false; }
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    services: { gemini: !!process.env.GEMINI_API_KEY, googleSheets: googleJsonOk() },
  });
});

function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1].trim() : String(text).trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1) throw new Error("AI returned bad format");
  return JSON.parse(raw.slice(start, end + 1));
}

function sanitizeSheetId(input) {
  const trimmed = (input || "").trim();
  const match = trimmed.match(/\/d\/([a-zA-Z0-9-_]+)/);
  return match ? match[1] : trimmed;
}

function norm(h) {
  return (h || "").trim().toLowerCase();
}

function identifyStartupName(capture) {
  const pc = capture.pageContext || {};
  return pc.companyNameHint || pc.title?.split("|")[0]?.split("-")[0]?.trim() || "Unknown Startup";
}

function getSheetsClient() {
  const credentials = parseGoogleCredentials();
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}

async function getSheetHeaders(sheetId) {
  const sheets = getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: "Sheet1!1:1",
  });
  const headers = res.data.values?.[0]?.filter(Boolean);
  if (!headers?.length) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: "Sheet1!1:1",
      valueInputOption: "RAW",
      requestBody: { values: [DEFAULT_HEADERS] },
    });
    return DEFAULT_HEADERS;
  }
  return headers;
}

function standardFieldValue(header, data) {
  const h = norm(header);
  const { record, capturedAt, sourceUrl } = data;
  const map = {
    "captured at": capturedAt,
    "startup name": record.startupName,
    "source url": sourceUrl,
    "screenshot link": "n/a",
    "founding year": record.foundingYear,
    "founders": record.founders,
    "founder background": record.founderBackground,
    "right to win": record.rightToWin,
    "funding raised": record.fundingRaised,
    "valuation": record.valuation,
    "arr / revenue": record.arrRevenue,
    "arr/revenue": record.arrRevenue,
    "key products": record.keyProducts,
    "investment thesis": record.investmentThesis,
    "why they stand out": record.whyTheyStandOut,
    "competitors (startups)": record.competitorsStartups,
    "competitors (incumbents)": record.competitorsIncumbents,
    "relevant links": record.relevantLinks,
    "confidence / notes": record.confidenceNotes,
    "job status": record.jobStatus || "completed",
  };
  return map[h] ?? record.extraFields?.[header] ?? record.extraFields?.[h] ?? "";
}

function buildRow(headers, data) {
  return headers.map((header) => {
    const val = standardFieldValue(header, data);
    return val == null ? "" : String(val);
  });
}

async function callGemini(prompt, useSearch = true) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY not set");

  let lastErr;
  for (const model of MODELS) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const body = {
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 4096 },
        };
        if (useSearch) body.tools = [{ google_search: {} }];

        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
          { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
        );
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);

        const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join("\n");
        if (!text) throw new Error("Empty AI response");
        return text;
      } catch (err) {
        lastErr = err;
        const msg = err.message || "";
        if (/503|429|high demand|not found|404|overload/i.test(msg)) {
          await new Promise((r) => setTimeout(r, 2500 * (attempt + 1)));
          continue;
        }
        break;
      }
    }
  }
  throw lastErr || new Error("All AI models failed");
}

function getCustomColumns(headers) {
  const known = new Set([
    "captured at", "startup name", "source url", "screenshot link",
    "founding year", "founders", "founder background", "right to win",
    "funding raised", "valuation", "arr / revenue", "arr/revenue",
    "key products", "investment thesis", "why they stand out",
    "competitors (startups)", "competitors (incumbents)",
    "relevant links", "confidence / notes", "job status",
  ]);
  return headers.filter((h) => !known.has(norm(h)));
}

async function runWebResearch(startupName, sourceUrl, customColumns = []) {
  const queries = RESEARCH_QUERIES(startupName);
  const customBlock = customColumns.length
    ? `\nAlso research and fill these CUSTOM columns in "extraFields" (use exact column names as keys):\n${customColumns.map((c) => `- "${c}"`).join("\n")}`
    : "";

  const researchPrompt = `You are a VC research analyst. RESEARCH this startup on the web using Google Search.

STARTUP: "${startupName}"
Trigger URL: ${sourceUrl}

Search queries to run:
${queries.map((q) => `- ${q}`).join("\n")}

Sources: Crunchbase, TechCrunch, company website, press, LinkedIn public info, interviews.

Return ONLY valid JSON:
{
  "startupName": "${startupName}",
  "foundingYear": "",
  "founders": "",
  "founderBackground": "",
  "rightToWin": "",
  "fundingRaised": "",
  "valuation": "",
  "arrRevenue": "",
  "keyProducts": "",
  "investmentThesis": "",
  "whyTheyStandOut": "",
  "competitorsStartups": "",
  "competitorsIncumbents": "",
  "relevantLinks": "",
  "confidenceNotes": "",
  "jobStatus": "completed",
  "extraFields": {}
}
${customBlock}

RULES:
- Web search only — trigger URL is just a hint
- Fill EVERY standard field; use "Unknown" if not findable
- Put custom column values inside extraFields using exact column names
- Mark estimates as (estimated)
- jobStatus: needs_review if >3 fields uncertain

Return ONLY JSON, no markdown.`;

  let raw;
  try {
    raw = await callGemini(researchPrompt, true);
  } catch {
    raw = await callGemini(researchPrompt, false);
  }
  const record = extractJson(raw);
  if (!record.extraFields) record.extraFields = {};
  return record;
}

async function appendToSheet(sheetId, data) {
  const sheets = getSheetsClient();
  let headers;
  try {
    headers = await getSheetHeaders(sheetId);
  } catch (e) {
    throw new Error(`Cannot access Google Sheet — share with service account. ${e.message}`);
  }

  const row = buildRow(headers, data);
  const colEnd = String.fromCharCode(64 + Math.min(headers.length, 26));
  const range = headers.length <= 26 ? `Sheet1!A:${colEnd}` : `Sheet1!A1`;

  const response = await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: headers.length <= 26 ? `Sheet1!A:${colEnd}` : "Sheet1!A:ZZ",
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [row] },
  });

  const rowMatch = (response.data.updates?.updatedRange || "").match(/(\d+)$/);
  const rowNumber = rowMatch ? parseInt(rowMatch[1], 10) : 0;
  return { sheetUrl: `https://docs.google.com/spreadsheets/d/${sheetId}/edit#gid=0&range=A${rowNumber}` };
}

async function processJob(jobId, capture, sheetId) {
  try {
    const startupName = identifyStartupName(capture);
    jobs.set(jobId, { id: jobId, status: "processing", progress: `Researching ${startupName}...`, startupName });

    const headers = await getSheetHeaders(sheetId);
    const customColumns = getCustomColumns(headers);
    const record = await runWebResearch(startupName, capture.pageContext?.url || "", customColumns);

    jobs.set(jobId, { ...jobs.get(jobId), progress: "Saving to Google Sheet..." });

    const { sheetUrl } = await appendToSheet(sheetId, {
      capturedAt: capture.capturedAt,
      sourceUrl: capture.pageContext?.url || "",
      record,
    });

    jobs.set(jobId, {
      id: jobId,
      status: record.jobStatus === "needs_review" ? "needs_review" : "completed",
      startupName: record.startupName,
      sheetRowUrl: sheetUrl,
      progress: "Done",
    });
  } catch (err) {
    console.error("Job failed:", err);
    jobs.set(jobId, { id: jobId, status: "failed", error: err.message || "Unknown error" });
  }
}

app.post("/api/capture", (req, res) => {
  const body = req.body;
  if (!body.pageContext?.companyNameHint && !body.pageContext?.title) {
    return res.status(400).json({ error: "Could not identify startup name from page" });
  }
  const sheetId = sanitizeSheetId(body.sheetId || process.env.GOOGLE_SHEET_ID);
  if (!sheetId) return res.status(400).json({ error: "No Google Sheet ID configured" });

  const jobId = uuidv4();
  jobs.set(jobId, { id: jobId, status: "queued" });
  processJob(jobId, body, sheetId).catch(console.error);
  res.status(202).json({ jobId, status: "queued" });
});

app.get("/api/jobs/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json({
    jobId: job.id, status: job.status, startupName: job.startupName,
    sheetRowUrl: job.sheetRowUrl, error: job.error, progress: job.progress,
  });
});

app.listen(PORT, () => console.log(`Startup Capture on port ${PORT}`));
