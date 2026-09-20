import "dotenv/config";
import express from "express";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";
import { google } from "googleapis";

const app = express();
const PORT = process.env.PORT || 3001;

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

function getAnthropicConfig() {
  const rawBase = (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/$/, "");
  const isMcKinsey = rawBase.includes("quantumblack.com");
  const messagesUrl = rawBase.endsWith("/v1")
    ? `${rawBase}/messages`
    : `${rawBase}/v1/messages`;
  return { messagesUrl, isMcKinsey, rawBase };
}

function researchEngine() {
  if (process.env.ANTHROPIC_API_KEY) return "claude";
  if (process.env.PERPLEXITY_API_KEY) return "perplexity";
  return "none";
}

app.get("/health", (_req, res) => {
  const engine = researchEngine();
  const { isMcKinsey } = getAnthropicConfig();
  res.json({
    ok: true,
    services: {
      claude: !!process.env.ANTHROPIC_API_KEY,
      perplexity: !!process.env.PERPLEXITY_API_KEY,
      googleSheets: googleJsonOk(),
    },
    engine,
    gateway: isMcKinsey ? "mckinsey-quantumblack" : "anthropic-public",
    quality: engine === "claude"
      ? isMcKinsey
        ? "high (McKinsey Claude + web search)"
        : "high (Claude + web search)"
      : engine === "perplexity"
        ? "high (Perplexity web research)"
        : "add ANTHROPIC_API_KEY in Render",
  });
});

function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1].trim() : String(text).trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1) throw new Error("AI returned invalid JSON");
  return JSON.parse(raw.slice(start, end + 1));
}

function extractTextFromAnthropic(data) {
  const blocks = data.content || [];
  const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  if (!text) throw new Error("Claude returned no text");
  return text;
}

function sanitizeSheetId(input) {
  const t = (input || "").trim();
  const m = t.match(/\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : t;
}

function norm(h) {
  return (h || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function extractIdentity(capture) {
  const pc = capture.pageContext || {};
  const url = pc.url || "";
  const linkedinMatch = url.match(/linkedin\.com\/company\/([^/?#]+)/i);
  const slug = linkedinMatch?.[1] || "";
  const name = pc.companyNameHint || pc.title?.split("|")[0]?.split("-")[0]?.trim() || slug || "Unknown";
  return { name, url, slug };
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

function resolveCell(header, data) {
  const h = norm(header);
  const { record, capturedAt, sourceUrl } = data;
  if (record.extraFields?.[header]) return record.extraFields[header];

  const map = {
    "captured at": capturedAt,
    "startup name": record.startupName,
    "source url": sourceUrl,
    "screenshot link": "n/a",
    "what is the company building": record.keyProducts || record.whatIsTheCompanyBuilding,
    "what is the company building?": record.keyProducts || record.whatIsTheCompanyBuilding,
    "founding year": record.foundingYear,
    "founders": record.founders,
    "founder background": record.founderBackground,
    "right to win": record.rightToWin,
    "funding raised": record.fundingRaised,
    "valuation": record.valuation,
    "arr / revenue": record.arrRevenue,
    "key products": record.keyProducts,
    "investment thesis": record.investmentThesis,
    "why they stand out": record.whyTheyStandOut,
    "competitors (startups)": record.competitorsStartups,
    "competitors (incumbents)": record.competitorsIncumbents,
    "relevant links": record.relevantLinks,
    "confidence / notes": record.confidenceNotes,
    "job status": record.jobStatus || "needs_review",
  };
  return map[h] ?? "";
}

function buildRow(headers, data) {
  return headers.map((h) => {
    const v = resolveCell(h, data);
    return v == null ? "" : String(v);
  });
}

function buildResearchPrompt(identity, sheetHeaders, searchContext) {
  const customCols = sheetHeaders.filter((h) => {
    const known = ["captured at","startup name","source url","screenshot link","founding year",
      "founders","founder background","right to win","funding raised","valuation",
      "arr / revenue","key products","investment thesis","why they stand out",
      "competitors (startups)","competitors (incumbents)","relevant links",
      "confidence / notes","job status","what is the company building","what is the company building?"];
    return !known.includes(norm(h));
  });

  return `You are a senior VC analyst at a top-tier fund. Produce an investment thesis dossier.

${identity.slug ? `CRITICAL IDENTITY LOCK: This is the company with LinkedIn slug "${identity.slug}" at ${identity.url}. Do NOT confuse with other companies named "${identity.name}".` : `Company: "${identity.name}" from ${identity.url}`}

${searchContext ? `WEB SEARCH RESULTS (use ONLY these facts — do not invent anything beyond them):\n${searchContext}\n` : "Research thoroughly. Check: company website, Crunchbase, LinkedIn, TechCrunch, PitchBook news, founder interviews, press releases."}

Return ONLY valid JSON:
{
  "startupName": "${identity.name}",
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

FIELD GUIDELINES:
- founders: full names, comma-separated
- founderBackground: education + career highlights (2-3 sentences)
- rightToWin: why THESE founders win in THIS market based on track record
- fundingRaised: all rounds with amounts and lead investors e.g. "$12M Series A led by Sequoia (2024)"
- valuation: latest known, mark (estimated) if not confirmed
- arrRevenue: best available metric, mark (estimated) if needed
- keyProducts + whatIsTheCompanyBuilding: detailed product description
- investmentThesis: 2-3 sentence compelling VC investment case
- whyTheyStandOut: specific differentiation and traction signals
- competitorsStartups: direct startup competitors, comma-separated
- competitorsIncumbents: established players, comma-separated
- relevantLinks: comma-separated source URLs used
- confidenceNotes: what is verified vs estimated, any conflicts between sources
- jobStatus: "needs_review" if >2 key fields are estimated; else "completed"
${customCols.length ? `- extraFields: fill these custom columns with exact keys: ${customCols.map((c) => `"${c}"`).join(", ")}` : ""}

Never invent data. If a field is not in search results, write "Not found in search".`;
}

async function duckDuckGoSearch(query) {
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; StartupCapture/1.0)" },
    });
    if (!res.ok) return [];
    const html = await res.text();
    const results = [];
    const blocks = html.split('class="result__body"');
    for (const block of blocks.slice(1, 6)) {
      const titleMatch = block.match(/class="result__a"[^>]*>([^<]+)/);
      const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
      const linkMatch = block.match(/class="result__url"[^>]*>([^<]+)/);
      if (titleMatch) {
        results.push({
          title: titleMatch[1].trim(),
          snippet: snippetMatch ? snippetMatch[1].replace(/<[^>]+>/g, "").trim() : "",
          url: linkMatch ? linkMatch[1].trim() : "",
        });
      }
    }
    return results;
  } catch {
    return [];
  }
}

async function gatherSearchContext(identity) {
  const queries = [
    `${identity.name} startup founders funding crunchbase`,
    `${identity.slug || identity.name} series funding investors`,
    `${identity.name} company product what they build`,
    `${identity.name} competitors market`,
  ];

  const all = [];
  for (const q of queries) {
    const hits = await duckDuckGoSearch(q);
    all.push(...hits);
  }

  const seen = new Set();
  const unique = all.filter((r) => {
    const key = r.title + r.url;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return unique.slice(0, 20).map((r, i) =>
    `[${i + 1}] ${r.title}\nURL: ${r.url}\n${r.snippet}`
  ).join("\n\n");
}

async function callClaude(messagesUrl, key, body) {
  const res = await fetch(messagesUrl, {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return { ok: res.ok, status: res.status, data: res.ok ? await res.json() : null, err: res.ok ? "" : await res.text() };
}

async function researchWithClaude(prompt, identity) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY not set");

  const { messagesUrl, isMcKinsey } = getAnthropicConfig();
  const models = [
    "claude-sonnet-4-20250514",
    "claude-3-7-sonnet-latest",
    "claude-3-5-sonnet-20241022",
    "claude-3-5-sonnet-latest",
  ];

  let searchContext = "";
  if (isMcKinsey) {
    searchContext = await gatherSearchContext(identity);
  }

  const fullPrompt = isMcKinsey
    ? buildResearchPrompt(identity, [], searchContext)
    : prompt;

  let lastErr = "";

  for (const model of models) {
    // McKinsey gateway: web search tool not supported — use DDG + Claude
    const body = isMcKinsey
      ? { model, max_tokens: 4096, temperature: 0.1, messages: [{ role: "user", content: fullPrompt }] }
      : {
          model, max_tokens: 4096, temperature: 0.1,
          tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8 }],
          messages: [{ role: "user", content: fullPrompt }],
        };

    let result = await callClaude(messagesUrl, key, body);

    // If web search tool rejected, retry without it + DDG context
    if (!result.ok && !isMcKinsey && (result.err.includes("tool") || result.err.includes("web_search"))) {
      searchContext = await gatherSearchContext(identity);
      const fallbackPrompt = buildResearchPrompt(identity, [], searchContext);
      result = await callClaude(messagesUrl, key, {
        model, max_tokens: 4096, temperature: 0.1,
        messages: [{ role: "user", content: fallbackPrompt }],
      });
    }

    if (!result.ok) {
      lastErr = result.err;
      if (lastErr.includes("model") || lastErr.includes("not_found") || result.status === 404) continue;
      throw new Error(`Claude error: ${lastErr}`);
    }

    const record = extractJson(extractTextFromAnthropic(result.data));
    const cited = (result.data.content || [])
      .flatMap((b) => b.citations || [])
      .map((c) => c.url)
      .filter(Boolean);
    if (cited.length) {
      record.relevantLinks = [...new Set([...(record.relevantLinks || "").split(",").map((s) => s.trim()), ...cited])]
        .filter(Boolean).slice(0, 12).join(", ");
    }
    return record;
  }

  throw new Error(`Claude error: ${lastErr || "all models failed — check ANTHROPIC_BASE_URL and token expiry"}`);
}

async function researchWithPerplexity(prompt) {
  const key = process.env.PERPLEXITY_API_KEY;
  if (!key) throw new Error("PERPLEXITY_API_KEY not set");

  const res = await fetch("https://api.perplexity.ai/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "sonar-pro",
      messages: [
        { role: "system", content: "Expert VC analyst. Web search only. Return valid JSON." },
        { role: "user", content: prompt },
      ],
      temperature: 0.1,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    const res2 = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "sonar",
        messages: [
          { role: "system", content: "Expert VC analyst. Web search only. Return valid JSON." },
          { role: "user", content: prompt },
        ],
        temperature: 0.1,
      }),
    });
    if (!res2.ok) throw new Error(`Perplexity error: ${err}`);
    const data2 = await res2.json();
    const record = extractJson(data2.choices[0].message.content);
    if (data2.citations?.length) record.relevantLinks = data2.citations.slice(0, 10).join(", ");
    return record;
  }

  const data = await res.json();
  const record = extractJson(data.choices[0].message.content);
  if (data.citations?.length) {
    record.relevantLinks = [...new Set([...(record.relevantLinks || "").split(","), ...data.citations])]
      .filter(Boolean).slice(0, 12).join(", ");
  }
  return record;
}

async function runWebResearch(identity, sheetHeaders) {
  const prompt = buildResearchPrompt(identity, sheetHeaders);
  const engine = researchEngine();
  const record = engine === "claude"
    ? await researchWithClaude(prompt, identity)
    : await researchWithPerplexity(prompt);

  record.extraFields = record.extraFields || {};
  record.startupName = record.startupName || identity.name;
  if (!record.whatIsTheCompanyBuilding) record.whatIsTheCompanyBuilding = record.keyProducts;
  if (!record.keyProducts) record.keyProducts = record.whatIsTheCompanyBuilding;

  const sparse = !record.founders || !record.fundingRaised;
  if (sparse) record.jobStatus = "needs_review";

  return record;
}

async function appendToSheet(sheetId, data) {
  const sheets = getSheetsClient();
  const headers = await getSheetHeaders(sheetId);
  if (!headers.length) throw new Error("Row 1 must have column headers");

  const row = buildRow(headers, data);
  const response = await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: "Sheet1!A:ZZ",
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [row] },
  });

  const rowMatch = (response.data.updates?.updatedRange || "").match(/(\d+)$/);
  return {
    sheetUrl: `https://docs.google.com/spreadsheets/d/${sheetId}/edit#gid=0&range=A${rowMatch ? rowMatch[1] : 1}`,
  };
}

async function processJob(jobId, capture, sheetId) {
  try {
    const identity = extractIdentity(capture);
    const headers = await getSheetHeaders(sheetId);

    jobs.set(jobId, {
      id: jobId, status: "processing",
      progress: `Deep research on ${identity.name}...`,
      startupName: identity.name,
    });

    const record = await runWebResearch(identity, headers);

    jobs.set(jobId, { ...jobs.get(jobId), progress: "Saving to sheet..." });
    const { sheetUrl } = await appendToSheet(sheetId, {
      capturedAt: capture.capturedAt,
      sourceUrl: identity.url,
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
    jobs.set(jobId, { id: jobId, status: "failed", error: err.message });
  }
}

app.post("/api/capture", (req, res) => {
  const body = req.body;
  if (!body.pageContext?.companyNameHint && !body.pageContext?.title) {
    return res.status(400).json({ error: "Could not identify startup" });
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
