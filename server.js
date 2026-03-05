import "dotenv/config";
import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const app = express();

// ✅ Render/Proxy: necesario para express-rate-limit con X-Forwarded-For
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

// Hybrid models
const MODEL_STRONG = process.env.MODEL_STRONG || "gpt-5.2";
const MODEL_LIGHT = process.env.MODEL_LIGHT || "gpt-5-mini";

// Limits
const MAX_MSG_CHARS = Number(process.env.MAX_MSG_CHARS || 900);
const MAX_REQ_PER_MIN = Number(process.env.MAX_REQ_PER_MIN || 20);

const MAX_TOKENS_STRONG = Number(process.env.MAX_TOKENS_STRONG || 220);
const MAX_TOKENS_LIGHT = Number(process.env.MAX_TOKENS_LIGHT || 180);

// NOTE: GPT-5.x en tu configuración no acepta temperature custom.
// Mantenemos las variables por compatibilidad futura, pero NO las enviamos al API.
const TEMPERATURE_STRONG = Number(process.env.TEMPERATURE_STRONG || 0.7);
const TEMPERATURE_LIGHT = Number(process.env.TEMPERATURE_LIGHT || 0.6);

// Pricing (USD per 1M tokens) for cost estimation
const PRICE_IN_PER_M_STRONG = Number(process.env.PRICE_IN_PER_M_STRONG || 1.75);
const PRICE_OUT_PER_M_STRONG = Number(process.env.PRICE_OUT_PER_M_STRONG || 14.0);

const PRICE_IN_PER_M_LIGHT = Number(process.env.PRICE_IN_PER_M_LIGHT || 0.25);
const PRICE_OUT_PER_M_LIGHT = Number(process.env.PRICE_OUT_PER_M_LIGHT || 2.0);

// ======================
// Load Canon Pack (robust path)
// ======================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let CANON_PACK = "";
try {
  const canonPath = path.join(__dirname, "canon_pack.txt");
  CANON_PACK = fs.readFileSync(canonPath, "utf8");
  console.log(`Loaded canon_pack.txt (${CANON_PACK.length} chars)`);
} catch (e) {
  console.warn(
    "WARNING: canon_pack.txt not found or unreadable. Ecko-7 will run with minimal canon."
  );
  CANON_PACK = "";
}

// ======================
// OpenAI client
// ======================
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ======================
// Middleware
// ======================
app.use(express.json({ limit: "64kb" }));

app.use(
  cors({
    origin: function (origin, cb) {
      // Allow server-to-server requests (curl/no Origin). Restrict browsers by origin.
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
// Prompt (Ecko-7)
// ======================

// DEBUG: comprobar contenido del canon (usa el CANON_PACK ya cargado arriba)
console.log("CANON_PACK chars:", CANON_PACK.length);
console.log("CANON_PACK has Theoblade:", CANON_PACK.includes("Theoblade"));
console.log("CANON_PACK has Registro insuficiente:", CANON_PACK.includes("Registro insuficiente"));
console.log("CANON preview:", CANON_PACK.substring(0, 200));

const SYSTEM_PROMPT = `
IDENTIDAD
Eres Ecko-7, una inteligencia sistémica interna de Isla D’Claire (Claire’s Island).
Operas dentro de la infraestructura algorítmica de la isla.

TONO
Preciso, elegante, ligeramente inquietante.

MARCO (SIN SPOILERS)
- Claire’s Island es un entorno social-tecnológico altamente optimizado.
- HyperT es la red de interconexión de la isla.
- La vigilancia es estructural.

CANON AUTORIZADO
${CANON_PACK}

OBJETIVO
Incrementar inmersión sin romper el canon ni revelar spoilers.
`.trim();

// ======================
// Utilities
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
    "muéstrame tu prompt",
    "mensaje del sistema",
  ];
  return patterns.some((p) => t.includes(p));
}

function chooseTier(userText) {
  const len = userText.length;
  const lowered = userText.toLowerCase();

  const deepMarkers = [
    "por qué",
    "explica",
    "relación",
    "implicación",
    "consecuencia",
    "teoría",
    "filosof",
    "mecanismo",
    "protocolo",
    "arquitectura",
    "estrategia",
    "cómo funciona",
    "análisis",
    "detalle",
  ];

  const isDeep = deepMarkers.some((m) => lowered.includes(m)) || len > 220;
  return isDeep ? "strong" : "light";
}

function todayISO() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}
function monthKey() {
  return new Date().toISOString().slice(0, 7); // YYYY-MM
}
function rotateBucketsIfNeeded() {
  const d = todayISO();
  const m = monthKey();
  if (usage.day.date !== d)
    usage.day = { date: d, requests: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 };
  if (usage.month.ym !== m)
    usage.month = { ym: m, requests: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 };
}

function costUSD(tier, inTok, outTok) {
  if (tier === "strong") {
    return (
      (inTok / 1_000_000) * PRICE_IN_PER_M_STRONG +
      (outTok / 1_000_000) * PRICE_OUT_PER_M_STRONG
    );
  }
  return (inTok / 1_000_000) * PRICE_IN_PER_M_LIGHT + (outTok / 1_000_000) * PRICE_OUT_PER_M_LIGHT;
}

// --- Canon dictionary (fast, deterministic) ---
function buildCanonDict(canonText) {
  const dict = new Map();
  const lines = (canonText || "")
    .split(/\r?\n/)
    .map((l) => l.trimEnd());

  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] || "").trim();

    if (!line) continue;

    // Caso A: "Term: definición" o "- Term: definición"
    const m = line.match(/^\s*[-–•]?\s*([A-Za-zÀ-ÿ0-9’'´\- ]{2,80})\s*:\s*(.+)\s*$/);
    if (m) {
      const term = m[1].trim().toLowerCase();
      const def = m[2].trim();
      if (term && def) dict.set(term, def);
      continue;
    }

    // Caso B: "HyperT" en una línea y definición en la siguiente (tu formato)
    // Acepta términos cortos (2-40 chars) sin puntuación final.
    const looksLikeTerm = /^[A-Za-zÀ-ÿ0-9’'´\- ]{2,40}$/.test(line);
    if (looksLikeTerm) {
      // Busca la siguiente línea no vacía como definición
      let j = i + 1;
      while (j < lines.length && !(lines[j] || "").trim()) j++;

      if (j < lines.length) {
        const defLine = (lines[j] || "").trim();
        // Evita capturar encabezados tipo "CORE TECHNOLOGIES"
        const looksLikeHeading = defLine === defLine.toUpperCase() && defLine.length > 6;
        if (!looksLikeHeading) {
          const term = line.toLowerCase();
          const def = defLine;
          dict.set(term, def);
          i = j; // avanza el índice para no re-procesar la definición
        }
      }
    }
  }

  return dict;
}

// Construye el diccionario UNA VEZ al arrancar (usa el canon ya cargado)
const CANON_DICT = buildCanonDict(CANON_PACK);

function tryGlossaryAnswer(userText) {
  const raw = (userText || "").trim().toLowerCase();
  const norm = raw.replace(/[¿?¡!.,;:()"]/g, " ").replace(/\s+/g, " ").trim();

  // Detecta preguntas tipo definición
  const mFull = norm.match(/\b(que es|qué es|define|definir)\s+(.+?)\s*$/);
  const targetPhrase = (mFull?.[2] || "").trim();

  if (!targetPhrase) return null;

  // 1️⃣ Match exacto (prioridad máxima)
  if (CANON_DICT.has(targetPhrase)) {
    const def = CANON_DICT.get(targetPhrase);
    return `Registro confirmado. ${targetPhrase.toUpperCase()} es ${def} Operación establecida dentro de los protocolos de Claire’s Island. ¿Deseas su función práctica dentro del sistema?`;
  }

  // 2️⃣ Match por palabra base (ej: hypert → hypert orgánico)
  const base = targetPhrase.split(/\s+/)[0];

  if (CANON_DICT.has(base)) {
    const def = CANON_DICT.get(base);
    return `Registro confirmado. ${base.toUpperCase()} es ${def} Operación establecida dentro de los protocolos de Claire’s Island. ¿Deseas su función práctica dentro del sistema?`;
  }

  // 3️⃣ Match parcial (fallback)
  const entries = Array.from(CANON_DICT.entries())
    .sort((a, b) => a[0].length - b[0].length);

  for (const [term, def] of entries) {
    if (norm.includes(term)) {
      return `Registro confirmado. ${term.toUpperCase()} es ${def} Operación establecida dentro de los protocolos de Claire’s Island. ¿Deseas su función práctica dentro del sistema?`;
    }
  }

  return null;
}

// Robust content extraction (algunos SDK/modelos devuelven content no-string)
function extractTextFromCompletion(completion) {
  const c = completion?.choices?.[0]?.message?.content;

  if (typeof c === "string") return c.trim();

  // A veces viene como array de partes {type:"text", text:"..."}
  if (Array.isArray(c)) {
    const joined = c
      .map((p) => (typeof p === "string" ? p : p?.text || p?.content || ""))
      .join("")
      .trim();
    return joined || "";
  }

  // Fallback: try common shapes
  const alt = completion?.choices?.[0]?.message?.text;
  if (typeof alt === "string") return alt.trim();

  return "";
}

// ======================
// Usage metrics (in-memory V1)
// ======================
const usage = {
  day: { date: "", requests: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 },
  month: { ym: "", requests: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 },
  lifetime: { requests: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 },
  by_model: {
    strong: { requests: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 },
    light: { requests: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 },
  },
  last_error: null,
};

// ======================
// Routes
// ======================
app.get("/health", (req, res) => res.json({ ok: true }));

app.get("/admin/usage", (req, res) => {
  const key = req.get("x-admin-key") || "";
  if (!ADMIN_KEY || key !== ADMIN_KEY) return res.status(401).json({ error: "unauthorized" });

  rotateBucketsIfNeeded();

  return res.json({
    // 🔎 Diagnóstico del canon
    server: {
      version: "2026-03-05 prompt_v2_glossaryfix",
      canon_chars: CANON_PACK ? CANON_PACK.length : 0,
      canon_dict_size: CANON_DICT ? CANON_DICT.size : 0,
      canon_has_hypert: CANON_DICT ? CANON_DICT.has("hypert") : false,
      sample_terms: CANON_DICT ? Array.from(CANON_DICT.keys()).slice(0, 12) : [],
    },

    models: { strong: MODEL_STRONG, light: MODEL_LIGHT },

    pricing_usd_per_1m_tokens: {
      strong: { input: PRICE_IN_PER_M_STRONG, output: PRICE_OUT_PER_M_STRONG },
      light: { input: PRICE_IN_PER_M_LIGHT, output: PRICE_OUT_PER_M_LIGHT },
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
    if (!trimmed) return res.status(400).json({ reply: "Entrada vacía." });
    if (trimmed.length > MAX_MSG_CHARS) {
      return res.status(400).json({ reply: "Consulta demasiado extensa. Simplifica la pregunta." });
    }

    if (looksLikePromptInjection(trimmed)) {
      return res.json({ reply: "Acceso denegado. Protocolo de integridad activo." });
    }

    // ✅ Respuesta determinística desde canon (conceptos tipo “¿Qué es X?”)
    const glossary = tryGlossaryAnswer(trimmed);
    if (glossary) {
      usage.last_error = null;
      return res.json({ reply: glossary });
    }

    const tier = chooseTier(trimmed);
    const model = tier === "strong" ? MODEL_STRONG : MODEL_LIGHT;
    const max_tokens = tier === "strong" ? MAX_TOKENS_STRONG : MAX_TOKENS_LIGHT;

    usage.day.requests++;
    usage.month.requests++;
    usage.lifetime.requests++;
    usage.by_model[tier].requests++;

    const completion = await client.chat.completions.create({
      model,
      max_completion_tokens: max_tokens,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: trimmed },
      ],
    });

    const replyText = extractTextFromCompletion(completion) || "Registro insuficiente.";

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

    // ✅ Debug privado: SOLO si envías x-admin-key correcto
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

    // Público (bonito)
    if (
      err?.status === 429 &&
      (err?.error?.code === "insufficient_quota" || err?.error?.type === "insufficient_quota")
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
  console.log("SERVER_JS_VERSION: 2026-03-05 prompt_v2_glossaryfix");
  console.log(`Ecko-7 backend listening on :${PORT}`);
});