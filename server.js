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
const BOOK_ACCESS_CODE = process.env.BOOK_ACCESS_CODE || "";
const ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || "";
const NODE_LOG_URL = "https://www.claireisland.com/node-log";

// Hybrid models
const MODEL_STRONG = process.env.MODEL_STRONG || "gpt-5.2";
const MODEL_LIGHT = process.env.MODEL_LIGHT || "gpt-5-mini";

// Limits
const MAX_MSG_CHARS = Number(process.env.MAX_MSG_CHARS || 900);
const MAX_REQ_PER_MIN = Number(process.env.MAX_REQ_PER_MIN || 20);

const MAX_TOKENS_STRONG = Number(process.env.MAX_TOKENS_STRONG || 220);
const MAX_TOKENS_LIGHT = Number(process.env.MAX_TOKENS_LIGHT || 180);

// Precios (USD por 1M tokens) para estimación
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
      // Permite requests server-to-server (curl/no Origin). Restringe browsers por origin.
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

// DEBUG canon
console.log("CANON_PACK chars:", CANON_PACK.length);
console.log("CANON_PACK has Theoblade:", CANON_PACK.includes("Theoblade"));
console.log(
  "CANON_PACK has Registro insuficiente:",
  CANON_PACK.includes("Registro insuficiente")
);
console.log("CANON preview:", CANON_PACK.substring(0, 200));

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
Si el usuario pregunta por un personaje, responde usando exclusivamente la información de CHARACTER ARCHIVE / KEY FIGURES del canon.
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

  const isDeep = deepMarkers.some((m) => lowered.includes(m)) || len > 220;
  return isDeep ? "strong" : "light";
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
    .replace(/[¿?¡!.,;:()"]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizeText(s = "") {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’‘`´]/g, "'")
    .replace(/[^a-zA-Z0-9'\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// ======================
// Canon dictionary (fast, deterministic)
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
    const m = line.match(
      /^\s*[-–•]?\s*([A-Za-zÀ-ÿ0-9’'´\- ]{2,80})\s*:\s*(.+)\s*$/
    );
    if (m) {
      const term = normalizeGlossaryKey(m[1]);
      const def = (m[2] || "").trim();
      if (term && def) dict.set(term, def);
      continue;
    }

    // Caso B: término en una línea y definición en la siguiente
    const looksLikeTerm = /^[A-Za-zÀ-ÿ0-9’'´\- ]{2,40}$/.test(line);
    if (looksLikeTerm) {
      let j = i + 1;
      while (j < lines.length && !(lines[j] || "").trim()) j++;

      if (j < lines.length) {
        const defLine = (lines[j] || "").trim();
        const looksLikeHeading =
          defLine === defLine.toUpperCase() && defLine.length > 6;

        if (!looksLikeHeading) {
          const term = normalizeGlossaryKey(line);
          const def = defLine;
          if (term && def) dict.set(term, def);
          i = j;
        }
      }
    }
  }

  return dict;
}

const CANON_DICT = buildCanonDict(CANON_PACK);

function tryGlossaryAnswer(userText) {
  const raw = (userText || "").trim().toLowerCase();

  const norm = raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’‘`´]/g, "'")
    .replace(/[¿?¡!.,;:()"]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const mFull = norm.match(/\b(que es|que son|define|definir)\s+(.+?)\s*$/);
  let targetPhrase = (mFull?.[2] || "").trim();

  if (!targetPhrase) return null;

  targetPhrase = normalizeGlossaryKey(
    targetPhrase.replace(/^(un|una|el|la|los|las)\s+/, "").trim()
  );

  // Caso especial: Fauciss
  if (
    targetPhrase.includes("fauciss") ||
    norm.includes("fauciss")
  ) {
    return "Registro confirmado. FAUCISS son criaturas bioingenierizadas con cuerpo de águila cuadrúpeda y cabeza de lobo. Utilizadas como unidades de vigilancia, caza y recolección. Algunas muestran comportamiento emergente no previsto. Operación establecida dentro de los protocolos de Claire’s Island. ¿Deseas su función práctica dentro del sistema?";
  }

  // Match exacto
  if (CANON_DICT.has(targetPhrase)) {
    const def = CANON_DICT.get(targetPhrase);
    return `Registro confirmado. ${targetPhrase.toUpperCase()} es ${def} Operación establecida dentro de los protocolos de Claire’s Island. ¿Deseas su función práctica dentro del sistema?`;
  }

  // Match por palabra base
  const base = targetPhrase.split(/\s+/)[0];

  if (CANON_DICT.has(base)) {
    const def = CANON_DICT.get(base);
    return `Registro confirmado. ${base.toUpperCase()} es ${def} Operación establecida dentro de los protocolos de Claire’s Island. ¿Deseas su función práctica dentro del sistema?`;
  }

  // Match parcial
  const entries = Array.from(CANON_DICT.entries()).sort(
    (a, b) => a[0].length - b[0].length
  );

  for (const [term, def] of entries) {
    if (targetPhrase.includes(term) || norm.includes(term)) {
      return `Registro confirmado. ${term.toUpperCase()} es ${def} Operación establecida dentro de los protocolos de Claire’s Island. ¿Deseas su función práctica dentro del sistema?`;
    }
  }

  return null;
}

function tryCharacterAnswer(userText) {
  const q = normalizeText(userText);

  const characters = [
    {
      aliases: ["theoblade", "theoblade d'normaux", "theoblade d’normaux"],
      reply:
        "Registro recuperado. Theoblade D’Normaux: Individuo asociado a una anomalía emergente dentro del sistema de Claire’s Island. Clasificación sistémica: anomalía emergente. Estado del archivo: parcialmente clasificado.",
    },
    {
      aliases: [
        "caudiloux",
        "caudiloux ii",
        "caudiloux ii d'magnanis",
        "caudiloux ii d’magnanis",
      ],
      reply:
        "Registro recuperado. Caudiloux II D’Magnanis: Regente de Isla D'Claire y máxima autoridad política visible dentro de la estructura de gobierno de la isla. Clasificación sistémica: autoridad gubernamental. Estado del archivo: abierto.",
    },
    {
      aliases: ["kathy", "kathy d'pounier", "kathy d’pounier"],
      reply:
        "Registro recuperado. Kathy D’Pounier: Estudiante del Instituto de Estudios Especiales. Posee una sensibilidad emocional y cognitiva que produce resonancias detectables dentro de la red HyperT. Clasificación sistémica: estudiante del Instituto. Estado del archivo: abierto.",
    },
    {
      aliases: ["susan", "susan d'pounier", "susan d’pounier"],
      reply:
        "Registro recuperado. Susan D’Pounier: Amiga de Kathy. Observadora analítica del funcionamiento social de la isla y de las dinámicas del sistema HyperT. Clasificación sistémica: residente civil. Estado del archivo: abierto.",
    },
    {
      aliases: ["exta", "éxta"],
      reply:
        "Registro recuperado. Éxta: Individuo vinculado a fenómenos perceptivos y resonancias biotecnológicas dentro del entorno de Isla D'Claire. Su interacción con otros individuos genera variaciones detectables en la red emocional del sistema. Clasificación sistémica: entidad de interés sistémico. Estado del archivo: parcialmente clasificado.",
    },
    {
      aliases: ["scient", "freed scient"],
      reply:
        "Registro recuperado. Freed Scient: Investigador vinculado al estudio de fenómenos históricos y científicos asociados a la Espiral del Tiempo. Clasificación sistémica: investigador senior. Estado del archivo: parcialmente clasificado.",
    },
    {
      aliases: ["goreman", "veg goreman"],
      reply:
        "Registro recuperado. Veg Goreman: Senador influyente dentro de la estructura política de Clairetown. Participa activamente en decisiones estratégicas del Senado. Clasificación sistémica: autoridad política. Estado del archivo: abierto.",
    },
    {
      aliases: ["clyma"],
      reply:
        "Registro recuperado. Clyma: Figura emocionalmente intensa asociada a procesos de memoria, identidad y resonancia sistémica dentro de la red social de la isla. Clasificación sistémica: residente civil. Estado del archivo: parcialmente clasificado.",
    },
    {
      aliases: ["trianoux"],
      reply:
        "Registro recuperado. Trianoux: Actor político implicado en conflictos de poder dentro de la estructura gubernamental de la isla. Clasificación sistémica: operador político. Efectivo de la Guardia Postirana. Estado del archivo: parcialmente clasificado.",
    },
    
    {
  aliases: ["autiloux"],
  reply:
    "Registro recuperado. Autiloux: Jefe de la Guardia Postirana. Individuo asociado a operaciones estratégicas dentro de las dinámicas de poder que rodean Isla D'Claire. Su perfil combina observación analítica y participación en eventos críticos del sistema. Clasificación sistémica: operador estratégico. Estado del archivo: parcialmente clasificado."
    },

    ];

  for (const ch of characters) {
    for (const alias of ch.aliases) {
      if (q.includes(normalizeText(alias))) {
        return ch.reply;
      }
    }
  }

  return null;
}

// Extracción robusta del texto devuelto por el modelo
function extractTextFromCompletion(completion) {
  const c = completion?.choices?.[0]?.message?.content;

  if (typeof c === "string") return c.trim();

  if (Array.isArray(c)) {
    const joined = c
      .map((p) => (typeof p === "string" ? p : p?.text || p?.content || ""))
      .join("")
      .trim();
    return joined || "";
  }

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
  if (!token || typeof token !== "string" || !token.includes(".")) return false;

  const [payloadB64, sig] = token.split(".");
  if (!payloadB64 || !sig) return false;

  const expectedSig = crypto
    .createHmac("sha256", ACCESS_TOKEN_SECRET)
    .update(payloadB64)
    .digest("base64url");

  if (sig !== expectedSig) return false;

  try {
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
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
app.get("/health", (req, res) => res.json({ ok: true }));

app.post("/api/validate-access", (req, res) => {
  try {
    const code = (req.body?.code || "").trim();

    if (!code) {
      return res.status(400).json({ ok: false, error: "missing_code" });
    }

    if (!BOOK_ACCESS_CODE || !ACCESS_TOKEN_SECRET) {
      return res.status(500).json({ ok: false, error: "server_not_configured" });
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
      return res.status(500).json({ ok: false, error: "server_not_configured" });
    }

    const valid = verifyAccessToken(token);

    return res.json({ ok: valid });
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
      version: "2026-03-06 canon_working_v1",
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

    // Contabiliza la request siempre
    usage.day.requests++;
    usage.month.requests++;
    usage.lifetime.requests++;

    // Respuesta determinística desde canon (conceptos)
    const glossary = tryGlossaryAnswer(trimmed);
    if (glossary) {
      usage.last_error = null;
      return res.json({ reply: glossary });
    }

    // Respuesta determinística para personajes
    const character = tryCharacterAnswer(trimmed);
    if (character) {
      usage.last_error = null;
      return res.json({ reply: character });
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

    console.log("MODEL USED:", model);
    console.log("RAW CHOICE:", JSON.stringify(completion?.choices?.[0], null, 2));

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
  console.log("SERVER_JS_VERSION: 2026-03-06 canon_working_v1");
  console.log(`Ecko-7 backend listening on :${PORT}`);
});