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

const SHEET_COLUMNS = [
  "Captured At", "Startup Name", "Source URL", "Screenshot Link",
  "Founding Year", "Founders", "Founder Background", "Right to Win",
  "Funding Raised", "Valuation", "ARR / Revenue", "Key Products",
  "Investment Thesis", "Why They Stand Out", "Competitors (Startups)",
  "Competitors (Incumbents)", "Relevant Links", "Confidence / Notes", "Job Status",
];

const RESEARCH_QUERIES = (name, url) => [
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

function identifyStartupName(capture) {
  const pc = capture.pageContext || {};
  return (
    pc.companyNameHint ||
    pc.title?.split("|")[0]?.split("-")[0]?.trim() ||
    "Unknown Startup"
  );
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
        console.log(`Research OK via ${model}`);
        return text;
      } catch (err) {
        lastErr = err;
        const msg = err.message || "";
        const retry = /503|429|high demand|not found|404|overload/i.test(msg);
        if (retry) {
          await new Promise((r) => setTimeout(r, 2500 * (attempt + 1)));
          continue;
        }
        break;
      }
    }
  }
  throw lastErr || new Error("All AI models failed");
}

async function runWebResearch(startupName, sourceUrl) {
  const queries = RESEARCH_QUERIES(startupName, sourceUrl);
  const researchPrompt = `You are a VC research analyst. Your job is to RESEARCH a startup on the web — do NOT rely on any page scrape.

STARTUP TO RESEARCH: "${startupName}"
Trigger URL (where user found it): ${sourceUrl}

Use Google Search extensively. Run searches like:
${queries.map((q) => `- ${q}`).join("\n")}

Find from PUBLIC sources: Crunchbase, TechCrunch, company website, press releases, LinkedIn public profiles, interviews, Twitter/X.

After researching, return ONLY this JSON (fill EVERY field — use "Unknown" only if truly not findable after search):
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
  "jobStatus": "completed"
}

RULES:
- DO YOUR OWN RESEARCH via web search. The trigger URL is just a hint — search the whole web.
- founders: full names, comma-separated
- founderBackground: career history, education, prior companies
- rightToWin: why these founders can win based on their track record
- fundingRaised: all known rounds, amounts, lead investors
- valuation: latest known or (estimated) with note
- arrRevenue: if not public, write "Not publicly disclosed" or best estimate marked (estimated)
- investmentThesis: 2-3 sentence VC investment case
- whyTheyStandOut: differentiation, traction signals
- competitorsStartups + competitorsIncumbents: comma-separated names
- relevantLinks: comma-separated source URLs you actually used
- confidenceNotes: flag anything uncertain or conflicting
- jobStatus: "needs_review" if >3 fields are estimated/unknown

Return ONLY valid JSON, no markdown.`;

  let raw;
  try {
    raw = await callGemini(researchPrompt, true);
  } catch {
    raw = await callGemini(researchPrompt, false);
  }
  return extractJson(raw);
}

function getSheetsClient() {
  const credentials = parseGoogleCredentials();
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}

async function appendToSheet(sheetId, data) {
  const sheets = getSheetsClient();
  const { record, capturedAt, sourceUrl } = data;

  try {
    const existing = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId, range: "Sheet1!A1:S1",
    });
    if (!existing.data.values?.length) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetId, range: "Sheet1!A1:S1",
        valueInputOption: "RAW", requestBody: { values: [SHEET_COLUMNS] },
      });
    }
  } catch (e) {
    throw new Error(`Cannot access Google Sheet — share with service account. ${e.message}`);
  }

  const row = [
    capturedAt, record.startupName, sourceUrl, "n/a",
    record.foundingYear || "", record.founders || "", record.founderBackground || "",
    record.rightToWin || "", record.fundingRaised || "", record.valuation || "",
    record.arrRevenue || "", record.keyProducts || "", record.investmentThesis || "",
    record.whyTheyStandOut || "", record.competitorsStartups || "",
    record.competitorsIncumbents || "", record.relevantLinks || "",
    record.confidenceNotes || "", record.jobStatus || "completed",
  ];

  const response = await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId, range: "Sheet1!A:S",
    valueInputOption: "USER_ENTERED", insertDataOption: "INSERT_ROWS",
    requestBody: { values: [row] },
  });

  const rowMatch = (response.data.updates?.updatedRange || "").match(/(\d+)$/);
  const rowNumber = rowMatch ? parseInt(rowMatch[1], 10) : 0;
  return { sheetUrl: `https://docs.google.com/spreadsheets/d/${sheetId}/edit#gid=0&range=A${rowNumber}` };
}

async function processJob(jobId, capture, sheetId) {
  try {
    const startupName = identifyStartupName(capture);
    jobs.set(jobId, { id: jobId, status: "processing", progress: `Researching ${startupName} on the web...`, startupName });

    const record = await runWebResearch(startupName, capture.pageContext?.url || "");

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
