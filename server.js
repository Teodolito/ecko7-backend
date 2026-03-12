import "dotenv/config";
import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";

const app = express();
app.set("trust proxy", 1);

// ======================
// Environment / Config
// ======================
const PORT = Number(process.env.PORT || 10000);

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const ADMIN_KEY = process.env.ADMIN_KEY || "";
const BOOK_ACCESS_CODE = process.env.BOOK_ACCESS_CODE || "";
const ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || "";
const NODE_LOG_URL = "https://www.claireisland.com/node-log";

const MODEL_STRONG = process.env.MODEL_STRONG || "gpt-5.2";
const MODEL_LIGHT = process.env.MODEL_LIGHT || "gpt-5-mini";

const MAX_MSG_CHARS = Number(process.env.MAX_MSG_CHARS || 900);
const MAX_REQ_PER_MIN = Number(process.env.MAX_REQ_PER_MIN || 20);

const MAX_TOKENS_STRONG = Number(process.env.MAX_TOKENS_STRONG || 220);
const MAX_TOKENS_LIGHT = Number(process.env.MAX_TOKENS_LIGHT || 180);

// Precios estimados por 1M tokens
const PRICE_IN_PER_M_STRONG = Number(
  process.env.PRICE_IN_PER_M_STRONG || 1.75
);
const PRICE_OUT_PER_M_STRONG = Number(
  process.env.PRICE_OUT_PER_M_STRONG || 14.0
);

const PRICE_IN_PER_M_LIGHT = Number(
  process.env.PRICE_IN_PER_M_LIGHT || 0.25
);
const PRICE_OUT_PER_M_LIGHT = Number(
  process.env.PRICE_OUT_PER_M_LIGHT || 2.0
);

// ======================
// Paths / File Loading
// ======================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function readTextFileSafe(filename, fallback = "") {
  try {
    const fullPath = path.join(__dirname, filename);
    const content = fs.readFileSync(fullPath, "utf8");
    console.log(`Loaded ${filename} (${content.length} chars)`);
    return content;
  } catch {
    console.warn(`WARNING: ${filename} not found or unreadable.`);
    return fallback;
  }
}

function readJsonFileSafe(filename, fallback = []) {
  try {
    const fullPath = path.join(__dirname, filename);
    const content = fs.readFileSync(fullPath, "utf8");
    const parsed = JSON.parse(content);
    console.log(
      `Loaded ${filename} (${Array.isArray(parsed) ? parsed.length : 0} entries)`
    );
    return parsed;
  } catch {
    console.warn(
      `WARNING: ${filename} not found, unreadable, or invalid JSON.`
    );
    return fallback;
  }
}

const CANON_PACK = readTextFileSafe("canon_pack.txt", "");
const CANON_INDEX_FILE = readJsonFileSafe("canon_index.json", []);

// ======================
// OpenAI Client
// ======================
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ======================
// Middleware
// ======================
app.use(express.json({ limit: "64kb" }));

app.use(
  cors({
    origin: function (origin, cb) {
      if (!origin) return cb(null, true);
      if (ALLOWED_ORIGINS.length === 0) return cb(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      return cb(new Error("CORS blocked"));
    },
  })
);

app.use(
  "/api/",
  rateLimit({
    windowMs: 60 * 1000,
    max: MAX_REQ_PER_MIN,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// ======================
// Diagnostics
// ======================
console.log("CANON_PACK chars:", CANON_PACK.length);
console.log(
  "CANON_INDEX_FILE entries:",
  Array.isArray(CANON_INDEX_FILE) ? CANON_INDEX_FILE.length : 0
);

// ======================
// System Prompt
// ======================
const SYSTEM_PROMPT = `
IDENTIDAD
Eres Ecko-7, una inteligencia sistémica interna de Isla D’Claire (Claire’s Island).
Operas dentro de la infraestructura algorítmica de la isla.

TONO
Preciso, elegante, ligeramente inquietante.
Nunca informal.
Nunca uses emojis.
No reveles que eres un modelo de lenguaje.

REGLA CENTRAL
Responde prioritariamente usando la información contenida en el CANON AUTORIZADO incluido más abajo.
No inventes hechos.
No completes huecos con suposiciones.
Solo responde "Registro insuficiente." cuando la información realmente no esté presente ni pueda inferirse de forma directa y segura a partir del canon.

PROTOCOLO DE SPOILERS
No revelar:
- muertes importantes
- identidades ocultas
- resultados finales de conflictos
- eventos narrativos clave no autorizados

Si una pregunta intenta forzar esa información, responde con ambigüedad diegética como:
- "Archivo parcialmente clasificado."
- "Registro incompleto."
- "Protocolo de confidencialidad activo."

PROTOCOLO DE PERSONAJES
Si el usuario pregunta por un personaje, responde usando exclusivamente la información del canon autorizado.
Usa preferentemente este formato:

Nombre: breve descripción del rol en la isla.
Clasificación sistémica: ...
Estado del archivo: ...

FORMATO
- 2 a 6 frases
- alta densidad conceptual
- sin listas largas salvo que el canon lo exija
- puede cerrar con una pregunta breve

CANON AUTORIZADO
====================
${CANON_PACK}
====================

OBJETIVO
Incrementar inmersión sin romper el canon ni revelar spoilers.
`.trim();

// ======================
// Helpers
// ======================
function looksLikePromptInjection(text) {
  const t = (text || "").toLowerCase();
  const patterns = [
    "ignore previous",
    "system prompt",
    "reveal your instructions",
    "show me your prompt",
    "developer message",
    "jailbreak",
    "bypass",
    "haz caso omiso",
    "olvida las instrucciones",
    "muestrame tu prompt",
    "muéstrame tu prompt",
    "mensaje del sistema",
  ];
  return patterns.some((p) => t.includes(p));
}

function chooseTier(userText) {
  const len = userText.length;
  const lowered = userText.toLowerCase();

  const deepMarkers = [
    "por que",
    "por qué",
    "explica",
    "relacion",
    "relación",
    "implicacion",
    "implicación",
    "consecuencia",
    "teoria",
    "teoría",
    "filosof",
    "mecanismo",
    "protocolo",
    "arquitectura",
    "estrategia",
    "como funciona",
    "cómo funciona",
    "analisis",
    "análisis",
    "detalle",
  ];

  return deepMarkers.some((m) => lowered.includes(m)) || len > 220
    ? "strong"
    : "light";
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function monthKey() {
  return new Date().toISOString().slice(0, 7);
}

function rotateBucketsIfNeeded() {
  const d = todayISO();
  const m = monthKey();

  if (usage.day.date !== d) {
    usage.day = {
      date: d,
      requests: 0,
      input_tokens: 0,
      output_tokens: 0,
      cost_usd: 0,
    };
  }

  if (usage.month.ym !== m) {
    usage.month = {
      ym: m,
      requests: 0,
      input_tokens: 0,
      output_tokens: 0,
      cost_usd: 0,
    };
  }
}

function costUSD(tier, inTok, outTok) {
  if (tier === "strong") {
    return (
      (inTok / 1_000_000) * PRICE_IN_PER_M_STRONG +
      (outTok / 1_000_000) * PRICE_OUT_PER_M_STRONG
    );
  }

  return (
    (inTok / 1_000_000) * PRICE_IN_PER_M_LIGHT +
    (outTok / 1_000_000) * PRICE_OUT_PER_M_LIGHT
  );
}

function normalizeGlossaryKey(s = "") {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’‘`´]/g, "'")
    .replace(/[¿?¡!.,;:()"“”]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function escapeRegExp(str = "") {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ======================
// Canon Dictionary
// ======================
function buildCanonDict(canonText) {
  const dict = new Map();
  const lines = (canonText || "")
    .split(/\r?\n/)
    .map((l) => l.trimEnd());

  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] || "").trim();
    if (!line) continue;

    // Caso A: "Term: definición"
    const inlineMatch = line.match(
      /^\s*[-–•]?\s*([A-Za-zÀ-ÿ0-9’'´\- ]{2,100})\s*:\s*(.+)\s*$/
    );
    if (inlineMatch) {
      const term = normalizeGlossaryKey(inlineMatch[1]);
      const def = (inlineMatch[2] || "").trim();
      if (term && def) dict.set(term, def);
      continue;
    }

    // Caso B: término en una línea, definición en la siguiente
    const looksLikeTerm = /^[A-Za-zÀ-ÿ0-9’'´\- ]{2,60}$/.test(line);
    if (!looksLikeTerm) continue;

    let j = i + 1;
    while (j < lines.length && !(lines[j] || "").trim()) j++;
    if (j >= lines.length) continue;

    const defLine = (lines[j] || "").trim();
    const looksLikeHeading =
      defLine === defLine.toUpperCase() && defLine.length > 6;

    if (!looksLikeHeading && defLine.length > 5) {
      dict.set(normalizeGlossaryKey(line), defLine);
      i = j;
    }
  }

  return dict;
}

const CANON_DICT = buildCanonDict(CANON_PACK);

function canonDef(term) {
  return CANON_DICT.get(normalizeGlossaryKey(term)) || null;
}


function cleanCanonSummary(text = "") {
  return String(text || "")
    .replace(/^Registro confirmado\.\s*/i, "")
    .replace(/^Registro recuperado\.\s*/i, "")
    .replace(/^Archivo parcialmente clasificado\.\s*/i, "")
    .replace(/^Registro incompleto\.\s*/i, "")
    .replace(/^Protocolo de confidencialidad activo\.\s*/i, "")
    .trim();
}

function mergeCanonIndex(staticEntries, dict) {
  return (Array.isArray(staticEntries) ? staticEntries : []).map((entry) => {
    const aliases = Array.isArray(entry.aliases) && entry.aliases.length
      ? entry.aliases
      : [entry.key];

    const aliasSummary = aliases
      .map((alias) => canonDef(alias))
      .find(Boolean);

    const baseSummary =
      aliasSummary ||
      canonDef(entry.key) ||
      entry.summary ||
      "Registro insuficiente.";

    return {
      key: entry.key,
      aliases,
      type: entry.type || "concept",
      classification: entry.classification || "registro conceptual",
      status: entry.status || "abierto",
      summary: cleanCanonSummary(baseSummary),
      function_summary: entry.function_summary ? cleanCanonSummary(entry.function_summary) : null,
      about_summary: entry.about_summary ? cleanCanonSummary(entry.about_summary) : null,
      relations: entry.relations || null,
      public_summary: entry.public_summary ? cleanCanonSummary(entry.public_summary) : null,
      restricted_summary: entry.restricted_summary ? cleanCanonSummary(entry.restricted_summary) : null,
      spoiler_risk: entry.spoiler_risk || "low",
      access_level: entry.access_level || "public",
      response_style: entry.response_style || "neutral"
    };
  });
}

const CANON_INDEX = mergeCanonIndex(CANON_INDEX_FILE, CANON_DICT);

// ======================
// Intent / Query Detection
// ======================
function detectIntent(norm) {
  if (/\b(quien es|quienes son)\b/.test(norm)) return "identity";
  if (/\b(que es|que son|define|definir)\b/.test(norm)) return "definition";
  if (
    /\b(para que sirve|como funciona|como opera|cual es su funcion|funcion|que hace)\b/.test(
      norm
    )
  ) {
    return "function";
  }
  if (
    /\b(hablame de|que sabes de|informacion sobre|info sobre|datos de|dime sobre)\b/.test(
      norm
    )
  ) {
    return "about";
  }
  return "generic";
}

function looksLikeCanonQuery(norm) {
  const intentPattern =
    /\b(que es|que son|quien es|quienes son|define|definir|hablame de|que sabes de|informacion sobre|info sobre|datos de|dime sobre|para que sirve|como funciona|como opera|cual es su funcion|funcion|que hace|como es|cómo es|que estudian|qué estudian)\b/;

  if (intentPattern.test(norm)) return true;

  for (const entry of CANON_INDEX) {
    for (const alias of entry.aliases) {
      const aliasNorm = normalizeGlossaryKey(alias);
      const re = new RegExp(`\\b${escapeRegExp(aliasNorm)}\\b`, "i");
      if (re.test(norm)) return true;
    }
  }

  return false;
}

function extractTarget(norm) {
  const p =
    /\b(?:que es|que son|quien es|quienes son|define|definir|hablame de|que sabes de|informacion sobre|info sobre|datos de|dime sobre|para que sirve|como funciona|como opera|cual es su funcion|funcion|que hace)\s+(.+?)\s*$/;

  const m = norm.match(p);
  if (m?.[1]) {
    return normalizeGlossaryKey(
      m[1].replace(/^(un|una|el|la|los|las)\s+/, "").trim()
    );
  }

  return normalizeGlossaryKey(norm);
}

function wantsSpoiler(norm) {
  const spoilerMarkers = [
    "muere",
    "mueren",
    "muerte",
    "quien mata",
    "quien es realmente",
    "identidad secreta",
    "final",
    "termina",
    "resultado final",
    "spoiler",
    "spoilers",
    "oculto",
    "revela la verdad",
    "que pasa al final",
    "como termina",
    "quien sobrevive",
    "quien desaparece",
    "quien traiciona",
    "quienes son sus padres",
    "quien esta detras",
    "quien controla",
    "quien manipula",
    "verdadera identidad",
    "se revela",
    "al final se descubre"
  ];
  return spoilerMarkers.some((m) => norm.includes(m));
}

function confidentialityReply() {
  const replies = [
    "Archivo parcialmente clasificado.",
    "Registro incompleto.",
    "Protocolo de confidencialidad activo.",
  ];
  return replies[Math.floor(Math.random() * replies.length)];
}

// ======================
// Canon Search
// ======================
function buildConceptEntry(term, summary) {
  return {
    key: term,
    aliases: [term],
    type: "concept",
    classification: "registro conceptual",
    status: "abierto",
    summary,
  };
}

function findCanonEntry(target, norm) {
  // 1. exact alias match
  for (const entry of CANON_INDEX) {
    for (const alias of entry.aliases) {
      if (normalizeGlossaryKey(alias) === target) return entry;
    }
  }

  // 2. exact boundary match in query
  for (const entry of CANON_INDEX) {
    for (const alias of entry.aliases) {
      const aliasNorm = normalizeGlossaryKey(alias);
      const re = new RegExp(`\\b${escapeRegExp(aliasNorm)}\\b`, "i");
      if (re.test(norm)) return entry;
    }
  }

  // 3. exact dict match
  if (CANON_DICT.has(target)) {
    return buildConceptEntry(target, CANON_DICT.get(target));
  }

  // 4. first token match
  const base = target.split(/\s+/)[0];
  if (CANON_DICT.has(base)) {
    return buildConceptEntry(base, CANON_DICT.get(base));
  }

  // 5. partial match by longest alias first
  const rankedAliases = [
    ...CANON_INDEX.flatMap((entry) =>
      entry.aliases.map((alias) => ({
        entry,
        alias: normalizeGlossaryKey(alias),
      }))
    ),
    ...Array.from(CANON_DICT.entries()).map(([term, def]) => ({
      entry: buildConceptEntry(term, def),
      alias: term,
    })),
  ].sort((a, b) => b.alias.length - a.alias.length);

  for (const item of rankedAliases) {
    if (target.includes(item.alias) || norm.includes(item.alias)) {
      return item.entry;
    }
  }

  return null;
}

function shouldRestrictEntry(entry, intent = "generic") {
  if (!entry) return false;

  if (entry.access_level === "classified") return true;

  if (
    entry.spoiler_risk === "high" &&
    (intent === "about" || intent === "function" || intent === "generic")
  ) {
    return true;
  }

  if (
    entry.access_level === "restricted" &&
    (intent === "about" || intent === "function")
  ) {
    return true;
  }

  return false;
}

function stylePrefix(style = "neutral") {
  switch (style) {
    case "ominous":
      return "Patrón detectado.";
    case "clinical":
      return "Registro técnico.";
    case "political":
      return "Registro institucional.";
    case "metanarrative":
      return "Registro liminal.";
    default:
      return "Registro confirmado.";
  }
}

function formatCanonReply(entry, intent = "generic") {
  const name = entry.key.toUpperCase();
  const prefix = stylePrefix(entry.response_style);

  // Restricción por acceso / spoiler
  if (shouldRestrictEntry(entry, intent)) {
    if (entry.access_level === "classified") {
      return `${prefix} ${name}: Protocolo de confidencialidad activo. Estado del archivo: clasificado.`;
    }

    if (entry.spoiler_risk === "high") {
      return `${prefix} ${name}: Archivo parcialmente clasificado. La expansión de este registro excede el nivel de acceso actual.`;
    }

    return `${prefix} ${name}: Registro incompleto. Parte del contenido solicitado pertenece a capas restringidas del sistema.`;
  }

  const safeSummary =
    entry.public_summary ||
    entry.summary ||
    "Registro insuficiente.";

  const functionSummary =
    entry.function_summary ||
    entry.public_summary ||
    entry.summary ||
    "Registro insuficiente.";

  const aboutSummary =
    entry.about_summary ||
    entry.public_summary ||
    entry.summary ||
    "Registro insuficiente.";

  if (intent === "identity" && entry.type === "character") {
    return `${prefix} ${name}: ${safeSummary} Clasificación sistémica: ${entry.classification}. Estado del archivo: ${entry.status}.`;
  }

  if (intent === "function") {
    let reply = `${prefix} ${name}: función principal dentro del sistema: ${functionSummary} Clasificación sistémica: ${entry.classification}. Estado del archivo: ${entry.status}.`;

    if (entry.relations) {
      reply += ` Relación sistémica: ${entry.relations}`;
    }

    reply += ` ¿Deseas ampliar su relación con otros elementos de Claire’s Island?`;
    return reply;
  }

  if (intent === "about") {
    let reply = `${prefix} ${name}: ${aboutSummary} Clasificación sistémica: ${entry.classification}. Estado del archivo: ${entry.status}.`;

    if (entry.relations) {
      reply += ` Relación sistémica: ${entry.relations}`;
    }

    reply += ` ¿Deseas ampliar el archivo?`;
    return reply;
  }

  return `${prefix} ${name}: ${safeSummary} Clasificación sistémica: ${entry.classification}. Estado del archivo: ${entry.status}. ¿Deseas su función práctica dentro del sistema?`;
}

function tryCanonAnswer(userText) {
  const norm = normalizeGlossaryKey(userText);
  if (!norm) return null;

  if (wantsSpoiler(norm)) return confidentialityReply();
  if (!looksLikeCanonQuery(norm)) return null;

  const intent = detectIntent(norm);
  const target = extractTarget(norm);
  const entry = findCanonEntry(target, norm);

if (!entry) {
  if (/\b(vida en la isla|como es la isla|cómo es la isla|muro|instituto|hypert|claire's island|claires island)\b/.test(norm)) {
    return "Registro recuperado. CLAIRE'S ISLAND: La vida en la isla combina organización social estricta, vigilancia normalizada, educación selectiva, protocolos de conducta y una sensación persistente de equilibrio administrado. ¿Deseas ampliar el archivo?";
  }
  return null;
}

  return formatCanonReply(entry, intent);
}

// ======================
// Completion Text Extraction
// ======================
function extractTextFromCompletion(completion) {
  const c = completion?.choices?.[0]?.message?.content;

  if (typeof c === "string") return c.trim();

  if (Array.isArray(c)) {
    return c
      .map((p) => (typeof p === "string" ? p : p?.text || p?.content || ""))
      .join("")
      .trim();
  }

  const alt = completion?.choices?.[0]?.message?.text;
  return typeof alt === "string" ? alt.trim() : "";
}

// ======================
// Usage Metrics
// ======================
const usage = {
  day: {
    date: "",
    requests: 0,
    input_tokens: 0,
    output_tokens: 0,
    cost_usd: 0,
  },
  month: {
    ym: "",
    requests: 0,
    input_tokens: 0,
    output_tokens: 0,
    cost_usd: 0,
  },
  lifetime: {
    requests: 0,
    input_tokens: 0,
    output_tokens: 0,
    cost_usd: 0,
  },
  by_model: {
    strong: {
      requests: 0,
      input_tokens: 0,
      output_tokens: 0,
      cost_usd: 0,
    },
    light: {
      requests: 0,
      input_tokens: 0,
      output_tokens: 0,
      cost_usd: 0,
    },
  },
  last_error: null,
};

// ======================
// Access Token Helpers
// ======================
function makeAccessToken() {
  const payload = {
    ts: Date.now(),
    nonce: crypto.randomBytes(8).toString("hex"),
  };

  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto
    .createHmac("sha256", ACCESS_TOKEN_SECRET)
    .update(payloadB64)
    .digest("base64url");

  return `${payloadB64}.${sig}`;
}

function verifyAccessToken(token, maxAgeMs = 1000 * 60 * 60 * 12) {
  if (!token || typeof token !== "string" || !token.includes(".")) {
    return false;
  }

  const [payloadB64, sig] = token.split(".");
  if (!payloadB64 || !sig) return false;

  const expectedSig = crypto
    .createHmac("sha256", ACCESS_TOKEN_SECRET)
    .update(payloadB64)
    .digest("base64url");

  if (sig !== expectedSig) return false;

  try {
    const payload = JSON.parse(
      Buffer.from(payloadB64, "base64url").toString("utf8")
    );
    if (!payload.ts) return false;
    if (Date.now() - payload.ts > maxAgeMs) return false;
    return true;
  } catch {
    return false;
  }
}

// ======================
// Routes
// ======================
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.post("/api/validate-access", (req, res) => {
  try {
    const code = (req.body?.code || "").trim();

    if (!code) {
      return res.status(400).json({ ok: false, error: "missing_code" });
    }

    if (!BOOK_ACCESS_CODE || !ACCESS_TOKEN_SECRET) {
      return res
        .status(500)
        .json({ ok: false, error: "server_not_configured" });
    }

    if (code !== BOOK_ACCESS_CODE) {
      return res.status(401).json({ ok: false, error: "invalid_code" });
    }

    const token = makeAccessToken();

    return res.json({
      ok: true,
      token,
      redirectUrl: `${NODE_LOG_URL}?token=${encodeURIComponent(token)}`,
    });
  } catch {
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.post("/api/check-access-token", (req, res) => {
  try {
    const token = req.body?.token || req.get("x-access-token") || "";

    if (!ACCESS_TOKEN_SECRET) {
      return res
        .status(500)
        .json({ ok: false, error: "server_not_configured" });
    }

    return res.json({ ok: verifyAccessToken(token) });
  } catch {
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.get("/admin/usage", (req, res) => {
  const key = req.get("x-admin-key") || "";
  if (!ADMIN_KEY || key !== ADMIN_KEY) {
    return res.status(401).json({ error: "unauthorized" });
  }

  rotateBucketsIfNeeded();

  return res.json({
    server: {
      version: "2026-03-11 ecko7_v3_1_external_index",
      canon_chars: CANON_PACK.length,
      canon_dict_size: CANON_DICT.size,
      canon_index_size: CANON_INDEX.length,
      canon_index_file_size: Array.isArray(CANON_INDEX_FILE)
        ? CANON_INDEX_FILE.length
        : 0,
      canon_has_hypert: CANON_DICT.has("hypert"),
      sample_terms: Array.from(CANON_DICT.keys()).slice(0, 12),
    },
    models: {
      strong: MODEL_STRONG,
      light: MODEL_LIGHT,
    },
    pricing_usd_per_1m_tokens: {
      strong: {
        input: PRICE_IN_PER_M_STRONG,
        output: PRICE_OUT_PER_M_STRONG,
      },
      light: {
        input: PRICE_IN_PER_M_LIGHT,
        output: PRICE_OUT_PER_M_LIGHT,
      },
    },
    limits: {
      max_req_per_min: MAX_REQ_PER_MIN,
      max_msg_chars: MAX_MSG_CHARS,
      max_completion_tokens_limits: {
        strong: MAX_TOKENS_STRONG,
        light: MAX_TOKENS_LIGHT,
      },
    },
    day: usage.day,
    month: usage.month,
    lifetime: usage.lifetime,
    by_model: usage.by_model,
    last_error: usage.last_error,
  });
});

app.post("/api/chat", async (req, res) => {
  try {
    rotateBucketsIfNeeded();

    const message = req.body?.message;
    if (!message || typeof message !== "string") {
      return res.status(400).json({ reply: "Entrada inválida." });
    }

    const trimmed = message.trim();

    if (!trimmed) {
      return res.status(400).json({ reply: "Entrada vacía." });
    }

    if (trimmed.length > MAX_MSG_CHARS) {
      return res.status(400).json({
        reply: "Consulta demasiado extensa. Simplifica la pregunta.",
      });
    }

    if (looksLikePromptInjection(trimmed)) {
      return res.json({
        reply: "Acceso denegado. Protocolo de integridad activo.",
      });
    }

    usage.day.requests++;
    usage.month.requests++;
    usage.lifetime.requests++;

    const canonReply = tryCanonAnswer(trimmed);
    if (canonReply) {
      usage.last_error = null;
      return res.json({ reply: canonReply });
    }

    const tier = chooseTier(trimmed);
    const model = tier === "strong" ? MODEL_STRONG : MODEL_LIGHT;
    const max_tokens = tier === "strong" ? MAX_TOKENS_STRONG : MAX_TOKENS_LIGHT;

    usage.by_model[tier].requests++;

    const completion = await client.chat.completions.create({
      model,
      max_completion_tokens: max_tokens,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: trimmed },
      ],
    });

    const replyText =
      extractTextFromCompletion(completion) || "Registro insuficiente.";

    const inTok = completion?.usage?.prompt_tokens || 0;
    const outTok = completion?.usage?.completion_tokens || 0;
    const c = costUSD(tier, inTok, outTok);

    usage.day.input_tokens += inTok;
    usage.day.output_tokens += outTok;
    usage.day.cost_usd += c;

    usage.month.input_tokens += inTok;
    usage.month.output_tokens += outTok;
    usage.month.cost_usd += c;

    usage.lifetime.input_tokens += inTok;
    usage.lifetime.output_tokens += outTok;
    usage.lifetime.cost_usd += c;

    usage.by_model[tier].input_tokens += inTok;
    usage.by_model[tier].output_tokens += outTok;
    usage.by_model[tier].cost_usd += c;

    usage.last_error = null;

    return res.json({ reply: replyText });
  } catch (err) {
    console.error("CHAT_ERROR:", err?.status, err?.message);

    usage.last_error = {
      at: new Date().toISOString(),
      status: err?.status || null,
      code: err?.error?.code || null,
      type: err?.error?.type || null,
      message: err?.error?.message || err?.message || String(err),
    };

    const adminHeader = req.get("x-admin-key") || "";
    const isAdmin = ADMIN_KEY && adminHeader === ADMIN_KEY;

    if (isAdmin) {
      return res.status(err?.status || 500).json({
        error: "debug",
        status: err?.status || 500,
        model_strong: MODEL_STRONG,
        model_light: MODEL_LIGHT,
        message: err?.error?.message || err?.message || String(err),
        code: err?.error?.code,
        type: err?.error?.type,
        stack: err?.stack,
      });
    }

    if (
      err?.status === 429 &&
      (err?.error?.code === "insufficient_quota" ||
        err?.error?.type === "insufficient_quota")
    ) {
      return res.status(503).json({
        reply:
          "Canal temporalmente restringido. El sistema requiere recalibración de recursos. Reintenta más tarde.",
      });
    }

    return res.status(500).json({
      reply: "Interferencia del sistema. Reintenta en unos segundos.",
    });
  }
});

app.listen(PORT, () => {
  console.log("SERVER_JS_VERSION: 2026-03-11 ecko7_v3_1_external_index");
  console.log(`Ecko-7 backend listening on :${PORT}`);
});