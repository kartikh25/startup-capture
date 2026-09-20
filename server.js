import "dotenv/config";
import express from "express";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { google } from "googleapis";

const app = express();
const PORT = process.env.PORT || 3001;
const MODEL = "gemini-2.5-flash";

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

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    services: {
      gemini: !!process.env.GEMINI_API_KEY,
      googleSheets: !!process.env.GOOGLE_SERVICE_ACCOUNT_JSON,
    },
  });
});

function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1].trim() : text.trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("No JSON in AI response");
  return JSON.parse(raw.slice(start, end + 1));
}

function getGenAI() {
  if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not set");
  return new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
}

async function identifyStartup(capture) {
  const genAI = getGenAI();
  const model = genAI.getGenerativeModel({ model: MODEL });
  const { pageContext, screenshot } = capture;
  const hint = pageContext.companyNameHint || pageContext.title;

  const parts = [{
    text: `Extract startup name. Return ONLY JSON: {"name":string,"sector":string?,"website":string?}
URL: ${pageContext.url}
Title: ${pageContext.title}
Hint: ${hint}
Text: ${pageContext.visibleText.slice(0, 1500)}`,
  }];

  const match = screenshot?.match(/^data:(image\/\w+);base64,(.+)$/);
  if (match) {
    parts.push({ text: "Screenshot:" });
    parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
  }

  const result = await model.generateContent(parts);
  return extractJson(result.response.text());
}

async function researchStartup(startup, capture) {
  const genAI = getGenAI();
  const model = genAI.getGenerativeModel({ model: MODEL });
  const { pageContext } = capture;

  const prompt = `VC analyst dossier for ${startup.name}. Source: ${pageContext.url}
Page: ${pageContext.visibleText.slice(0, 3000)}

Return ONLY JSON:
{"startupName":"","foundingYear":"","founders":"","founderBackground":"","rightToWin":"","fundingRaised":"","valuation":"","arrRevenue":"","keyProducts":"","investmentThesis":"","whyTheyStandOut":"","competitorsStartups":"","competitorsIncumbents":"","relevantLinks":"","confidenceNotes":"","jobStatus":"completed"}
Mark estimates as (estimated). Use needs_review if uncertain.`;

  const result = await model.generateContent(prompt);
  const record = extractJson(result.response.text());
  record.startupName = record.startupName || startup.name;
  return record;
}

function getSheetsClient() {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON not set");
  }
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}

async function appendToSheet(sheetId, data) {
  const sheets = getSheetsClient();
  const { record, capturedAt, sourceUrl } = data;

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

  const row = [
    capturedAt, record.startupName, sourceUrl, "screenshot captured",
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

    const startup = await identifyStartup(capture);
    const record = await researchStartup(startup, capture);

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
    jobs.set(jobId, {
      id: jobId,
      status: "failed",
      error: err.message || "Unknown error",
    });
  }
}

app.post("/api/capture", (req, res) => {
  const body = req.body;
  if (!body.screenshot || !body.pageContext) {
    return res.status(400).json({ error: "Missing screenshot or pageContext" });
  }

  const sheetId = body.sheetId || process.env.GOOGLE_SHEET_ID;
  if (!sheetId) {
    return res.status(400).json({ error: "No Google Sheet ID configured" });
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

app.listen(PORT, () => {
  console.log(`Startup Capture running on port ${PORT}`);
});
