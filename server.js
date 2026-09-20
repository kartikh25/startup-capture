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

const jobs = new Map();

app.use(cors());
app.use(express.json({ limit: "15mb" }));

function parseGoogleCredentials() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON not set");
  let text = String(raw).trim();
  if (text.startsWith('"') && text.endsWith('"')) {
    try { text = JSON.parse(text); } catch { /* keep */ }
  }
  text = String(text).trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1) throw new Error("Google JSON invalid");
  return JSON.parse(text.slice(start, end + 1));
}

function googleJsonOk() {
  try {
    const c = parseGoogleCredentials();
    return !!(c.client_email && c.private_key);
  } catch { return false; }
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, services: { gemini: !!process.env.GEMINI_API_KEY, googleSheets: googleJsonOk() } });
});

function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1].trim() : String(text).trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1) throw new Error("AI bad format");
  return JSON.parse(raw.slice(start, end + 1));
}

function sanitizeSheetId(input) {
  const t = (input || "").trim();
  const m = t.match(/\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : t;
}

function norm(h) {
  return (h || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function identifyStartupName(capture) {
  const pc = capture.pageContext || {};
  return pc.companyNameHint || pc.title?.split("|")[0]?.split("-")[0]?.trim() || "Unknown Startup";
}

function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: parseGoogleCredentials(),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}

async function getSheetHeaders(sheetId) {
  const sheets = getSheetsClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: "Sheet1!1:1" });
  return res.data.values?.[0]?.filter((h) => h && String(h).trim()) || [];
}

// Maps normalized header → value from record
function resolveCell(header, data) {
  const h = norm(header);
  const { record, capturedAt, sourceUrl } = data;

  // Direct extraFields match (exact header from sheet)
  if (record.extraFields?.[header]) return record.extraFields[header];
  if (record.extraFields?.[h]) return record.extraFields[h];

  const aliases = {
    "captured at": capturedAt,
    "startup name": record.startupName,
    "source url": sourceUrl,
    "screenshot link": "n/a",
    "what is the company building": record.keyProducts || record.whatIsTheCompanyBuilding,
    "what is the company building?": record.keyProducts || record.whatIsTheCompanyBuilding,
    "company building": record.keyProducts,
    "founding year": record.foundingYear,
    "founders": record.founders,
    "founder background": record.founderBackground,
    "right to win": record.rightToWin,
    "funding raised": record.fundingRaised,
    "valuation": record.valuation,
    "arr / revenue": record.arrRevenue,
    "arr/revenue": record.arrRevenue,
    "revenue": record.arrRevenue,
    "key products": record.keyProducts,
    "investment thesis": record.investmentThesis,
    "why they stand out": record.whyTheyStandOut,
    "competitors (startups)": record.competitorsStartups,
    "competitors startups": record.competitorsStartups,
    "competitors (incumbents)": record.competitorsIncumbents,
    "competitors incumbents": record.competitorsIncumbents,
    "relevant links": record.relevantLinks,
    "confidence / notes": record.confidenceNotes,
    "confidence notes": record.confidenceNotes,
    "job status": record.jobStatus || "completed",
  };

  if (aliases[h] != null && aliases[h] !== "") return aliases[h];
  return record.extraFields?.[header] ?? "";
}

function buildRow(headers, data) {
  return headers.map((header) => {
    const val = resolveCell(header, data);
    return val == null ? "" : String(val);
  });
}

async function callGemini(prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY not set");

  let lastErr;
  for (const model of MODELS) {
    for (let attempt = 0; attempt < 3; attempt++) {
      for (const useSearch of [true, false]) {
        try {
          const body = {
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.3, maxOutputTokens: 8192 },
          };
          if (useSearch) body.tools = [{ google_search: {} }];

          const res = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
            { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
          );
          const data = await res.json();
          if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);

          const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join("\n");
          if (!text) throw new Error("Empty response");
          console.log(`OK: ${model} search=${useSearch}`);
          return text;
        } catch (err) {
          lastErr = err;
          if (/503|429|404|not found|high demand|overload/i.test(err.message || "")) {
            await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
          }
        }
      }
    }
  }
  throw lastErr || new Error("AI failed");
}

async function runWebResearch(startupName, sourceUrl, sheetHeaders) {
  const headerList = sheetHeaders.map((h) => `"${h}"`).join(", ");

  const prompt = `You are a senior VC analyst. Research startup "${startupName}" thoroughly using Google Search.

Trigger URL (hint only): ${sourceUrl}

SEARCH THE WEB for:
- Company website, Crunchbase, TechCrunch, LinkedIn, press releases
- Founders names, backgrounds, LinkedIn career history
- All funding rounds, investors, valuation
- Revenue/ARR if public
- Product description, what they build
- Competitors (startups + incumbents)
- Investment thesis: why fundable?

Return ONLY this JSON:
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
  "whatIsTheCompanyBuilding": "",
  "investmentThesis": "",
  "whyTheyStandOut": "",
  "competitorsStartups": "",
  "competitorsIncumbents": "",
  "relevantLinks": "",
  "confidenceNotes": "",
  "jobStatus": "completed",
  "extraFields": {}
}

CRITICAL RULES:
- DO REAL WEB RESEARCH. Do NOT write "Unknown" unless you searched and found nothing.
- If not public: write "Not publicly disclosed" NOT "Unknown"
- If estimated: write "$50M (estimated)" format
- founders: actual names from search
- founderBackground: 2-3 sentences on career
- rightToWin: why founders can win this market
- fundingRaised: "$X Series A led by Y" format
- investmentThesis: 2-3 compelling sentences
- keyProducts AND whatIsTheCompanyBuilding: detailed product description
- relevantLinks: comma-separated URLs you used
- extraFields: fill ANY of these sheet columns not covered above, using EXACT column names as keys:
  ${headerList}

jobStatus = "needs_review" only if most financial data is estimated.

Return ONLY valid JSON.`;

  const raw = await callGemini(prompt);
  const record = extractJson(raw);
  record.extraFields = record.extraFields || {};
  if (!record.whatIsTheCompanyBuilding) record.whatIsTheCompanyBuilding = record.keyProducts;
  if (!record.keyProducts) record.keyProducts = record.whatIsTheCompanyBuilding;
  return record;
}

async function appendToSheet(sheetId, data) {
  const sheets = getSheetsClient();
  const headers = await getSheetHeaders(sheetId);
  if (!headers.length) throw new Error("Sheet has no headers in row 1");

  const row = buildRow(headers, data);
  console.log("Headers:", headers);
  console.log("Row:", row);

  const response = await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: "Sheet1!A:ZZ",
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
    const headers = await getSheetHeaders(sheetId);

    jobs.set(jobId, { id: jobId, status: "processing", progress: `Researching ${startupName}...`, startupName });

    const record = await runWebResearch(startupName, capture.pageContext?.url || "", headers);

    jobs.set(jobId, { ...jobs.get(jobId), progress: "Saving..." });

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
    jobs.set(jobId, { id: jobId, status: "failed", error: err.message });
  }
}

app.post("/api/capture", (req, res) => {
  const body = req.body;
  if (!body.pageContext?.companyNameHint && !body.pageContext?.title) {
    return res.status(400).json({ error: "Could not identify startup name" });
  }
  const sheetId = sanitizeSheetId(body.sheetId || process.env.GOOGLE_SHEET_ID);
  if (!sheetId) return res.status(400).json({ error: "No Sheet ID" });

  const jobId = uuidv4();
  jobs.set(jobId, { id: jobId, status: "queued" });
  processJob(jobId, body, sheetId).catch(console.error);
  res.status(202).json({ jobId, status: "queued" });
});

app.get("/api/jobs/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Not found" });
  res.json({
    jobId: job.id, status: job.status, startupName: job.startupName,
    sheetRowUrl: job.sheetRowUrl, error: job.error, progress: job.progress,
  });
});

app.listen(PORT, () => console.log(`Startup Capture on port ${PORT}`));
