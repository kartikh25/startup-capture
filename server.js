import "dotenv/config";
import express from "express";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";
import { google } from "googleapis";

const app = express();
const PORT = process.env.PORT || 3001;

// Try these in order — lite models first (less busy on free tier)
const MODELS = [
  "gemini-2.0-flash-lite",
  "gemini-2.5-flash-lite",
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-3.5-flash",
];

const SHEET_COLUMNS = [
  "Captured At", "Startup Name", "Source URL", "Screenshot Link",
  "Founding Year", "Founders", "Founder Background", "Right to Win",
  "Funding Raised", "Valuation", "ARR / Revenue", "Key Products",
  "Investment Thesis", "Why They Stand Out", "Competitors (Startups)",
  "Competitors (Incumbents)", "Relevant Links", "Confidence / Notes", "Job Status",
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
  if (start === -1) throw new Error("Google JSON invalid — re-paste in Render Environment");
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
    services: {
      gemini: !!process.env.GEMINI_API_KEY,
      googleSheets: googleJsonOk(),
    },
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

function buildFallbackRecord(capture, reason) {
  const pc = capture.pageContext;
  const name = pc.companyNameHint || pc.title?.split("|")[0]?.trim() || "Unknown";
  return {
    startupName: name,
    keyProducts: pc.metaDescription || "",
    investmentThesis: (pc.visibleText || "").slice(0, 400),
    relevantLinks: pc.url,
    confidenceNotes: `AI unavailable (${reason}). Page data saved — review manually.`,
    jobStatus: "needs_review",
  };
}

async function callGemini(prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY not set");

  let lastErr;
  for (const model of MODELS) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: { temperature: 0.2, maxOutputTokens: 2048 },
            }),
          }
        );
        const data = await res.json();
        if (!res.ok) {
          const msg = data?.error?.message || `HTTP ${res.status}`;
          throw new Error(msg);
        }
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) throw new Error("Empty AI response");
        console.log(`Gemini OK: ${model}`);
        return extractJson(text);
      } catch (err) {
        lastErr = err;
        const msg = err.message || "";
        const retry = msg.includes("503") || msg.includes("429") || msg.includes("high demand") || msg.includes("not found") || msg.includes("404");
        if (retry) {
          await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
          continue;
        }
        break;
      }
    }
  }
  throw lastErr || new Error("All Gemini models failed");
}

async function runResearch(capture) {
  const pc = capture.pageContext;
  const hint = pc.companyNameHint || pc.title;

  const prompt = `VC analyst. Return ONLY valid JSON, no markdown.

Startup page: ${pc.url}
Title: ${pc.title}
Company hint: ${hint}
Description: ${pc.metaDescription}
Page text: ${(pc.visibleText || "").slice(0, 2500)}

JSON schema:
{"startupName":"","foundingYear":"","founders":"","founderBackground":"","rightToWin":"","fundingRaised":"","valuation":"","arrRevenue":"","keyProducts":"","investmentThesis":"","whyTheyStandOut":"","competitorsStartups":"","competitorsIncumbents":"","relevantLinks":"","confidenceNotes":"","jobStatus":"completed"}

Use page text for answers. Mark unknown fields empty. Mark estimates (estimated). jobStatus=needs_review if uncertain.`;

  try {
    const record = await callGemini(prompt);
    record.startupName = record.startupName || hint;
    record.relevantLinks = record.relevantLinks || pc.url;
    return record;
  } catch (err) {
    console.error("AI failed, using fallback:", err.message);
    return buildFallbackRecord(capture, err.message.slice(0, 80));
  }
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
      spreadsheetId: sheetId,
      range: "Sheet1!A1:S1",
    });
    if (!existing.data.values?.length) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: "Sheet1!A1:S1",
        valueInputOption: "RAW",
        requestBody: { values: [SHEET_COLUMNS] },
      });
    }
  } catch (e) {
    throw new Error(`Cannot access Google Sheet — share sheet with service account email. ${e.message}`);
  }

  const row = [
    capturedAt, record.startupName, sourceUrl, "captured",
    record.foundingYear || "", record.founders || "", record.founderBackground || "",
    record.rightToWin || "", record.fundingRaised || "", record.valuation || "",
    record.arrRevenue || "", record.keyProducts || "", record.investmentThesis || "",
    record.whyTheyStandOut || "", record.competitorsStartups || "",
    record.competitorsIncumbents || "", record.relevantLinks || "",
    record.confidenceNotes || "", record.jobStatus || "completed",
  ];

  const response = await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: "Sheet1!A:S",
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [row] },
  });

  const updatedRange = response.data.updates?.updatedRange || "";
  const rowMatch = updatedRange.match(/(\d+)$/);
  const rowNumber = rowMatch ? parseInt(rowMatch[1], 10) : 0;

  return {
    sheetUrl: `https://docs.google.com/spreadsheets/d/${sheetId}/edit#gid=0&range=A${rowNumber}`,
  };
}

async function processJob(jobId, capture, sheetId) {
  try {
    jobs.set(jobId, { id: jobId, status: "processing", progress: "Researching..." });

    const record = await runResearch(capture);

    jobs.set(jobId, { ...jobs.get(jobId), progress: "Saving to sheet...", startupName: record.startupName });

    const { sheetUrl } = await appendToSheet(sheetId, {
      capturedAt: capture.capturedAt,
      sourceUrl: capture.pageContext.url,
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
  if (!body.pageContext) {
    return res.status(400).json({ error: "Missing pageContext" });
  }
  const sheetId = sanitizeSheetId(body.sheetId || process.env.GOOGLE_SHEET_ID);
  if (!sheetId) {
    return res.status(400).json({ error: "No Google Sheet ID — set in extension settings" });
  }
  const jobId = uuidv4();
  jobs.set(jobId, { id: jobId, status: "queued" });
  processJob(jobId, body, sheetId).catch(console.error);
  res.status(202).json({ jobId, status: "queued" });
});

app.get("/api/jobs/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json({
    jobId: job.id,
    status: job.status,
    startupName: job.startupName,
    sheetRowUrl: job.sheetRowUrl,
    error: job.error,
    progress: job.progress,
  });
});

app.listen(PORT, () => console.log(`Startup Capture on port ${PORT}`));
