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
const SERVER_VERSION = "2026-03-16 ecko7_v5_canon_index_stateful";

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
const MAX_STATE_AGE_MS = Number(process.env.MAX_STATE_AGE_MS || 1000 * 60 * 30);
const MAX_STATE_ENTRIES = Number(process.env.MAX_STATE_ENTRIES || 5000);

const PRICE_IN_PER_M_STRONG = Number(process.env.PRICE_IN_PER_M_STRONG || 1.75);
const PRICE_OUT_PER_M_STRONG = Number(process.env.PRICE_OUT_PER_M_STRONG || 14.0);
const PRICE_IN_PER_M_LIGHT = Number(process.env.PRICE_IN_PER_M_LIGHT || 0.25);
const PRICE_OUT_PER_M_LIGHT = Number(process.env.PRICE_OUT_PER_M_LIGHT || 2.0);

// ======================
// Load canon files
// ======================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function readTextFileSafe(fileName, fallback = "") {
  try {
    return fs.readFileSync(path.join(__dirname, fileName), "utf8");
  } catch (err) {
    console.warn(`WARNING: ${fileName} not found or unreadable.`, err?.message || err);
    return fallback;
  }
}

function readJsonFileSafe(fileName, fallback = []) {
  try {
    const raw = fs.readFileSync(path.join(__dirname, fileName), "utf8");
    return JSON.parse(raw);
  } catch (err) {
    console.warn(`WARNING: ${fileName} not found, invalid or unreadable.`, err?.message || err);
    return fallback;
  }
}

const CANON_PACK = readTextFileSafe("canon_pack.txt", "");
const CANON_INDEX_FILE = readJsonFileSafe("canon_index.json", []);

console.log(`Loaded canon_pack.txt (${CANON_PACK.length} chars)`);
console.log(`Loaded canon_index.json (${Array.isArray(CANON_INDEX_FILE) ? CANON_INDEX_FILE.length : 0} entries)`);
console.log("CANON_PACK chars:", CANON_PACK.length);
console.log("CANON_PACK has Theoblade:", CANON_PACK.includes("Theoblade"));
console.log(
  "CANON_PACK has Registro insuficiente:",
  CANON_PACK.includes("Registro insuficiente")
);
console.log("CANON preview:", CANON_PACK.substring(0, 200));

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
    origin(origin, cb) {
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
const NORMALIZATION_MAP = {
  "ecolibriun": "ecolibrium",
  "ecolibrioum": "ecolibrium",
  "hyper t": "hypert",
  "hyper-t": "hypert",
  "inner t": "innert",
  "inner-t": "innert",
  "teoblade": "theoblade",
  "theo blade": "theoblade",
  "ecko 7": "ecko-7",
  "ecko7": "ecko-7",
  "anomalia": "anomalia",
  "anomalia de theoblade": "anomalia theoblade",
};

const AFFIRMATIVE_TOKENS = new Set([
  "si",
  "sí",
  "claro",
  "ok",
  "vale",
  "de acuerdo",
  "adelante",
  "ajá",
  "aja",
  "correcto",
  "yes",
  "please",
  "por favor",
]);

const NEGATIVE_TOKENS = new Set(["no", "negativo", "cancelar"]);

const DEEP_MARKERS = [
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
  "diferencia",
  "compar",
];

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
  const isDeep = DEEP_MARKERS.some((m) => lowered.includes(m)) || len > 220;
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
  return applyNormalizationMap(
    s
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[’‘`´]/g, "'")
      .replace(/[¿?¡!.,;:()\[\]"]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase()
  );
}

function normalizeText(s = "") {
  return applyNormalizationMap(
    s
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[’‘`´]/g, "'")
      .replace(/[^a-zA-Z0-9'\-\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase()
  );
}

function applyNormalizationMap(text = "") {
  let out = text;
  const keys = Object.keys(NORMALIZATION_MAP).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    out = out.replaceAll(key, NORMALIZATION_MAP[key]);
  }
  return out.replace(/\s+/g, " ").trim();
}

function inferCanonicalIntent(userText, state = null) {
  const q = normalizeText(userText);

  if (!q) return "unknown";
  if (q === "si" || q === "sí" || AFFIRMATIVE_TOKENS.has(q)) return "followup_affirmation";
  if (NEGATIVE_TOKENS.has(q)) return "followup_negative";
  if (/\b(quien es|quién es)\b/.test(q)) return "identify_character";
  if (/\b(que es|que son|define|definir)\b/.test(q)) return "define_entity";
  if (/\b(cual es la diferencia|cuál es la diferencia|diferencia entre|comparar|compara)\b/.test(q)) return "difference_query";
  if (/\b(como funciona|cómo funciona|como opera|cómo opera|funciona)\b/.test(q)) return "system_explanation";
  if (/\b(que relacion|qué relación|relacion entre|relación entre|vinculo entre|vínculo entre)\b/.test(q)) return "relationship_query";
  if (/\b(por que|por qué|por cual|por cuál|causa de|motivo de)\b/.test(q)) {
    if (q.includes("theoblade") || q.includes("anomalia")) return "anomaly_query";
    return "causal_query";
  }
  if (/\b(explica mejor|amplia|amplía|profundiza|mas detalle|más detalle)\b/.test(q)) return "clarification_request";
  if (q.includes("hypert") || q.includes("innert") || q.includes("anomalia") || q.includes("theoblade")) {
    if (state?.pendingFollowup) return "unknown_but_related";
  }
  return "unknown";
}

function buildCanonDict(canonText) {
  const dict = new Map();
  const lines = (canonText || "")
    .split(/\r?\n/)
    .map((l) => l.trimEnd());

  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] || "").trim();
    if (!line) continue;

    const m = line.match(/^\s*[-–•]?\s*([A-Za-zÀ-ÿ0-9’'´\- ]{2,80})\s*:\s*(.+)\s*$/);
    if (m) {
      const term = normalizeGlossaryKey(m[1]);
      const def = (m[2] || "").trim();
      if (term && def) dict.set(term, def);
      continue;
    }

    const looksLikeTerm = /^[A-Za-zÀ-ÿ0-9’'´\- ]{2,40}$/.test(line);
    if (looksLikeTerm) {
      let j = i + 1;
      while (j < lines.length && !(lines[j] || "").trim()) j++;
      if (j < lines.length) {
        const defLine = (lines[j] || "").trim();
        const looksLikeHeading = defLine === defLine.toUpperCase() && defLine.length > 6;
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

function normalizeIndexEntry(entry = {}) {
  const aliases = Array.isArray(entry.aliases) ? entry.aliases : [];
  const keywords = Array.isArray(entry.keywords) ? entry.keywords : [];
  const intentTags = Array.isArray(entry.intent_tags) ? entry.intent_tags : [];
  const followups = Array.isArray(entry.followups) ? entry.followups : [];
  const relationIds = Array.isArray(entry.relation_ids) ? entry.relation_ids : [];

  return {
    ...entry,
    key: entry.key || entry.id || entry.title || "",
    normalized_key: normalizeGlossaryKey(entry.normalized_key || entry.key || entry.id || entry.title || ""),
    aliases_normalized: aliases.map((a) => normalizeGlossaryKey(a)).filter(Boolean),
    keywords_normalized: keywords.map((k) => normalizeGlossaryKey(k)).filter(Boolean),
    intent_tags: intentTags,
    followups,
    relation_ids: relationIds,
    priority: Number(entry.priority || 0.5),
    access_level: entry.access_level || accessLevelFromStatus(entry.status),
    type: entry.type || "concept",
    summary:
      entry.summary ||
      entry.public_summary ||
      entry.function_summary ||
      entry.about_summary ||
      entry.restricted_summary ||
      "",
  };
}

function accessLevelFromStatus(status = "") {
  const s = String(status).toLowerCase();
  if (s.includes("clasificado") || s.includes("parcial")) return "restricted";
  if (s.includes("abierto") || s.includes("public")) return "public";
  return "public";
}

const CANON_DICT = buildCanonDict(CANON_PACK);
const CANON_INDEX = Array.isArray(CANON_INDEX_FILE)
  ? CANON_INDEX_FILE.map(normalizeIndexEntry).filter((e) => e.normalized_key)
  : [];

function getCanonicalKeyFromQuery(q = "") {
  const norm = normalizeText(q);
  if (norm.includes("anomalia") && norm.includes("theoblade")) return "anomalia";
  if (norm.includes("hypert")) return "hypert";
  if (norm.includes("innert")) return "innert";
  if (norm.includes("theoblade")) return "theoblade";
  if (norm.includes("ecko-7")) return "ecko-7";
  return "";
}

function findCanonCandidates(userText, intent, state = null) {
  const q = normalizeText(userText);
  const tokens = new Set(q.split(/\s+/).filter(Boolean));
  const contextIds = new Set(state?.recentEntities || []);

  return CANON_INDEX.map((entry) => {
    let score = 0;

    if (q === entry.normalized_key) score += 1.2;
    if (entry.aliases_normalized.includes(q)) score += 1.1;

    for (const alias of entry.aliases_normalized) {
      if (!alias) continue;
      if (q.includes(alias)) score += alias.length > 5 ? 0.7 : 0.45;
    }

    for (const kw of entry.keywords_normalized) {
      if (tokens.has(kw) || q.includes(kw)) score += 0.12;
    }

    if (entry.normalized_key && q.includes(entry.normalized_key)) score += 0.85;
    if (contextIds.has(entry.normalized_key)) score += 0.2;
    if ((entry.relation_ids || []).some((id) => contextIds.has(normalizeGlossaryKey(id)))) score += 0.12;

    if (intent === "identify_character" && entry.type === "character") score += 0.45;
    if (intent === "system_explanation" && entry.type === "system") score += 0.4;
    if (intent === "difference_query" && (entry.normalized_key === "hypert" || entry.normalized_key === "innert")) score += 0.35;
    if (intent === "anomaly_query" && (entry.normalized_key === "anomalia" || entry.normalized_key === "theoblade")) score += 0.55;
    if (intent === "relationship_query" && (entry.relation_ids || []).length) score += 0.15;
    if ((entry.intent_tags || []).includes(intent)) score += 0.25;

    score += entry.priority * 0.25;

    return { entry, score };
  })
    .filter((x) => x.score > 0.25)
    .sort((a, b) => b.score - a.score);
}

function buildIndexAnswer(entry, intent, state = null) {
  const name = entry.key || entry.normalized_key.toUpperCase();
  const access = entry.access_level || "public";
  const summary =
    access === "restricted"
      ? entry.public_summary || entry.summary || entry.function_summary || entry.about_summary
      : entry.summary || entry.public_summary || entry.function_summary || entry.about_summary;
  const functionSummary = entry.function_summary || entry.about_summary || "";
  const restricted = entry.restricted_summary || "";

  let body = "";
  if (intent === "difference_query" && (entry.normalized_key === "hypert" || entry.normalized_key === "innert")) {
    body = summary || functionSummary;
  } else if (intent === "relationship_query" && entry.relations) {
    body = `${summary} ${entry.relations}`.trim();
  } else if (intent === "anomaly_query" && entry.normalized_key === "anomalia") {
    body = (entry.about_summary || summary || "").trim();
    if (access === "restricted" && restricted) {
      body += " Alcance total no disponible en esta capa de acceso.";
    }
  } else {
    body = [summary, functionSummary].filter(Boolean).slice(0, 2).join(" ");
  }

  body = compactText(body || "Registro insuficiente.");

  const followupQuestion = chooseFollowup(entry, intent, state);
  return followupQuestion ? `${body} ${followupQuestion}` : body;
}

function compactText(text = "") {
  return text.replace(/\s+/g, " ").trim();
}

function chooseFollowup(entry, intent, state = null) {
  const followups = Array.isArray(entry.followups) ? entry.followups.filter(Boolean) : [];
  if (!followups.length) return "";

  if (intent === "difference_query") {
    const preferred = followups.find((f) => /diferencia|innert|hypert/i.test(f));
    return preferred || followups[0];
  }

  if (state?.lastEntityId && state.lastEntityId === entry.normalized_key && followups.length > 1) {
    return followups[1];
  }

  return followups[0];
}

function buildDifferenceAnswer(first, second) {
  const a = first?.public_summary || first?.summary || first?.about_summary || "";
  const b = second?.public_summary || second?.summary || second?.about_summary || "";
  const aName = first?.key || "HyperT";
  const bName = second?.key || "InnerT";

  const head = `${aName} y ${bName} no son capas equivalentes.`;
  const bodyA = `${aName}: ${compactText(a)}`;
  const bodyB = `${bName}: ${compactText(b)}`;
  const tail = "¿Quieres la comparación en clave técnica o narrativa?";
  return compactText(`${head} ${bodyA} ${bodyB} ${tail}`);
}

function tryGlossaryAnswer(userText) {
  const raw = (userText || "").trim().toLowerCase();
  const norm = normalizeGlossaryKey(raw);
  const mFull = norm.match(/\b(que es|que son|define|definir)\s+(.+?)\s*$/);
  let targetPhrase = (mFull?.[2] || "").trim();
  if (!targetPhrase) return null;

  targetPhrase = normalizeGlossaryKey(targetPhrase.replace(/^(un|una|el|la|los|las)\s+/, "").trim());

  if (targetPhrase.includes("fauciss") || norm.includes("fauciss")) {
    return "Registro confirmado. FAUCISS son criaturas bioingenierizadas con cuerpo de águila cuadrúpeda y cabeza de lobo. Utilizadas como unidades de vigilancia, caza y recolección. Algunas muestran comportamiento emergente no previsto. Operación establecida dentro de los protocolos de Claire’s Island. ¿Deseas su función práctica dentro del sistema?";
  }

  if (CANON_DICT.has(targetPhrase)) {
    const def = CANON_DICT.get(targetPhrase);
    return `Registro confirmado. ${targetPhrase.toUpperCase()} es ${def} Operación establecida dentro de los protocolos de Claire’s Island. ¿Deseas su función práctica dentro del sistema?`;
  }

  const fromIndex = CANON_INDEX.find(
    (entry) => entry.normalized_key === targetPhrase || entry.aliases_normalized.includes(targetPhrase)
  );
  if (fromIndex) {
    return buildIndexAnswer(fromIndex, "define_entity");
  }

  const base = targetPhrase.split(/\s+/)[0];
  if (CANON_DICT.has(base)) {
    const def = CANON_DICT.get(base);
    return `Registro confirmado. ${base.toUpperCase()} es ${def} Operación establecida dentro de los protocolos de Claire’s Island. ¿Deseas su función práctica dentro del sistema?`;
  }

  const entries = Array.from(CANON_DICT.entries()).sort((a, b) => a[0].length - b[0].length);
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
      aliases: ["caudiloux", "caudiloux ii", "caudiloux ii d'magnanis", "caudiloux ii d’magnanis"],
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
        "Registro recuperado. Autiloux: Jefe de la Guardia Postirana. Individuo asociado a operaciones estratégicas dentro de las dinámicas de poder que rodean Isla D'Claire. Su perfil combina observación analítica y participación en eventos críticos del sistema. Clasificación sistémica: operador estratégico. Estado del archivo: parcialmente clasificado.",
    },
  ];

  for (const ch of characters) {
    for (const alias of ch.aliases) {
      if (q.includes(normalizeText(alias))) {
        return ch.reply;
      }
    }
  }

  const indexCharacter = CANON_INDEX.find(
    (entry) => entry.type === "character" && (q.includes(entry.normalized_key) || entry.aliases_normalized.some((a) => q.includes(a)))
  );
  if (indexCharacter) {
    return buildIndexAnswer(indexCharacter, "identify_character");
  }

  return null;
}

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
// Conversation state
// ======================
const conversationState = new Map();

function makeSessionId(req) {
  const fromBody = req.body?.sessionId;
  if (typeof fromBody === "string" && fromBody.trim()) {
    return fromBody.trim().slice(0, 120);
  }
  const raw = `${req.ip || "ip-unknown"}|${req.get("user-agent") || "ua-unknown"}`;
  return crypto.createHash("sha1").update(raw).digest("hex");
}

function getState(sessionId) {
  pruneConversationState();
  const current = conversationState.get(sessionId);
  if (current && Date.now() - current.updatedAt < MAX_STATE_AGE_MS) {
    return current;
  }
  const fresh = {
    lastIntent: null,
    lastEntityId: null,
    recentEntities: [],
    pendingFollowup: null,
    anomalyContext: false,
    updatedAt: Date.now(),
  };
  conversationState.set(sessionId, fresh);
  return fresh;
}

function saveState(sessionId, nextState) {
  nextState.updatedAt = Date.now();
  conversationState.set(sessionId, nextState);
  pruneConversationState();
}

function pruneConversationState() {
  const now = Date.now();
  for (const [key, value] of conversationState.entries()) {
    if (!value?.updatedAt || now - value.updatedAt > MAX_STATE_AGE_MS) {
      conversationState.delete(key);
    }
  }
  if (conversationState.size <= MAX_STATE_ENTRIES) return;

  const ordered = Array.from(conversationState.entries()).sort((a, b) => (a[1].updatedAt || 0) - (b[1].updatedAt || 0));
  const excess = ordered.length - MAX_STATE_ENTRIES;
  for (let i = 0; i < excess; i++) {
    conversationState.delete(ordered[i][0]);
  }
}

function detectFollowupIntent(userText, state) {
  const norm = normalizeText(userText);
  const isAffirmative = AFFIRMATIVE_TOKENS.has(norm);
  const isNegative = NEGATIVE_TOKENS.has(norm);
  const hasPendingFollowup = Boolean(state?.pendingFollowup);

  return {
    isFollowup: hasPendingFollowup && (isAffirmative || isNegative || norm.length <= 18),
    isAffirmative,
    isNegative,
    normalized: norm,
  };
}

function buildFollowupReply(userText, state) {
  const norm = normalizeText(userText);
  const pending = state?.pendingFollowup;
  if (!pending) return null;

  if (NEGATIVE_TOKENS.has(norm)) {
    state.pendingFollowup = null;
    return "Continuidad cancelada. Puedes consultar otro registro.";
  }

  const entity = CANON_INDEX.find((e) => e.normalized_key === pending.entityId);
  if (!entity) {
    state.pendingFollowup = null;
    return "Registro insuficiente.";
  }

  let reply = "";
  if (pending.type === "offer_deeper_explanation") {
    const expanded = entity.about_summary || entity.function_summary || entity.summary || entity.public_summary || "";
    reply = compactText(expanded || "Registro insuficiente.");
  } else if (pending.type === "offer_relation_expansion") {
    reply = compactText(entity.relations || entity.about_summary || entity.summary || "Registro insuficiente.");
  } else if (pending.type === "offer_compare_hypert_innert") {
    const otherId = entity.normalized_key === "hypert" ? "innert" : "hypert";
    const other = CANON_INDEX.find((e) => e.normalized_key === otherId);
    reply = buildDifferenceAnswer(entity, other);
  } else if (pending.type === "offer_anomaly_extension") {
    const restrictedTail = entity.restricted_summary
      ? `${compactText(entity.restricted_summary)} Protocolo de confidencialidad activo sobre capas ulteriores.`
      : "Archivo parcialmente clasificado.";
    reply = compactText(`${entity.about_summary || entity.summary || ""} ${restrictedTail}`);
  } else {
    reply = buildIndexAnswer(entity, state.lastIntent || "clarification_request", state);
  }

  state.pendingFollowup = null;
  state.lastEntityId = entity.normalized_key;
  state.recentEntities = pushRecentEntity(state.recentEntities, entity.normalized_key);
  state.anomalyContext = state.anomalyContext || entity.normalized_key === "anomalia" || entity.normalized_key === "theoblade";
  return compactText(reply);
}

function pushRecentEntity(list = [], entityId) {
  const next = [entityId, ...list.filter((x) => x !== entityId)].filter(Boolean);
  return next.slice(0, 6);
}

function buildSoftFallback(userText, state) {
  const q = normalizeText(userText);
  if (state?.lastEntityId) {
    const lastEntry = CANON_INDEX.find((e) => e.normalized_key === state.lastEntityId);
    if (lastEntry) {
      return `No encuentro un registro exacto para esa formulación, pero la consulta parece vinculada a ${lastEntry.key || lastEntry.normalized_key}. ¿Quieres que lo desarrolle desde ese marco?`;
    }
  }

  if (q.includes("hypert") || q.includes("innert") || q.includes("theoblade") || q.includes("anomalia")) {
    return "La consulta apunta a una capa sensible del sistema. Reformúlala sobre HyperT, InnerT o la anomalía y abriré el registro más cercano permitido.";
  }

  return "Registro insuficiente.";
}

function updateStateFromEntry(state, entry, intent) {
  state.lastIntent = intent;
  state.lastEntityId = entry.normalized_key;
  state.recentEntities = pushRecentEntity(state.recentEntities, entry.normalized_key);
  state.anomalyContext = state.anomalyContext || entry.normalized_key === "anomalia" || entry.normalized_key === "theoblade";

  if (intent === "difference_query" && (entry.normalized_key === "hypert" || entry.normalized_key === "innert")) {
    state.pendingFollowup = { type: "offer_compare_hypert_innert", entityId: entry.normalized_key };
    return;
  }

  if (entry.normalized_key === "hypert" || entry.normalized_key === "innert") {
    state.pendingFollowup = { type: "offer_deeper_explanation", entityId: entry.normalized_key };
    return;
  }

  if (entry.normalized_key === "anomalia" || (entry.normalized_key === "theoblade" && intent === "anomaly_query")) {
    state.pendingFollowup = { type: "offer_anomaly_extension", entityId: entry.normalized_key === "theoblade" ? "anomalia" : entry.normalized_key };
    return;
  }

  if (entry.relations) {
    state.pendingFollowup = { type: "offer_relation_expansion", entityId: entry.normalized_key };
    return;
  }

  if (entry.followups?.length) {
    state.pendingFollowup = { type: "offer_deeper_explanation", entityId: entry.normalized_key };
    return;
  }

  state.pendingFollowup = null;
}

function tryCanonAnswer(userText, state) {
  const normalized = normalizeText(userText);
  const followup = detectFollowupIntent(normalized, state);
  if (followup.isFollowup) {
    return buildFollowupReply(normalized, state);
  }

  const intent = inferCanonicalIntent(normalized, state);

  if (intent === "difference_query" && normalized.includes("hypert") && normalized.includes("innert")) {
    const hypert = CANON_INDEX.find((e) => e.normalized_key === "hypert");
    const innert = CANON_INDEX.find((e) => e.normalized_key === "innert");
    if (hypert && innert) {
      state.lastIntent = intent;
      state.lastEntityId = "hypert";
      state.recentEntities = pushRecentEntity(pushRecentEntity(state.recentEntities, "hypert"), "innert");
      state.pendingFollowup = { type: "offer_compare_hypert_innert", entityId: "hypert" };
      return buildDifferenceAnswer(hypert, innert);
    }
  }

  const candidates = findCanonCandidates(normalized, intent, state);
  const best = candidates[0];
  if (!best || best.score < 0.6) {
    return buildSoftFallback(normalized, state);
  }

  const answer = buildIndexAnswer(best.entry, intent, state);
  updateStateFromEntry(state, best.entry, intent);
  return answer;
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
  const payload = { ts: Date.now(), nonce: crypto.randomBytes(8).toString("hex") };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", ACCESS_TOKEN_SECRET).update(payloadB64).digest("base64url");
  return `${payloadB64}.${sig}`;
}

function verifyAccessToken(token, maxAgeMs = 1000 * 60 * 60 * 12) {
  if (!token || typeof token !== "string" || !token.includes(".")) return false;
  const [payloadB64, sig] = token.split(".");
  if (!payloadB64 || !sig) return false;

  const expectedSig = crypto.createHmac("sha256", ACCESS_TOKEN_SECRET).update(payloadB64).digest("base64url");
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
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    version: SERVER_VERSION,
    canon_pack_loaded: Boolean(CANON_PACK),
    canon_index_entries: CANON_INDEX.length,
  });
});

app.post("/api/validate-access", (req, res) => {
  try {
    const code = (req.body?.code || "").trim();
    if (!code) return res.status(400).json({ ok: false, error: "missing_code" });
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
      version: SERVER_VERSION,
      canon_chars: CANON_PACK.length,
      canon_dict_size: CANON_DICT.size,
      canon_index_size: CANON_INDEX.length,
      canon_index_file_size: Array.isArray(CANON_INDEX_FILE) ? CANON_INDEX_FILE.length : 0,
      canon_has_hypert: CANON_DICT.has("hypert") || CANON_INDEX.some((x) => x.normalized_key === "hypert"),
      canon_has_innert: CANON_DICT.has("innert") || CANON_INDEX.some((x) => x.normalized_key === "innert"),
      canon_has_anomalia: CANON_INDEX.some((x) => x.normalized_key === "anomalia"),
      state_cache_size: conversationState.size,
      sample_terms: Array.from(CANON_DICT.keys()).slice(0, 12),
    },
    models: { strong: MODEL_STRONG, light: MODEL_LIGHT },
    pricing_usd_per_1m_tokens: {
      strong: { input: PRICE_IN_PER_M_STRONG, output: PRICE_OUT_PER_M_STRONG },
      light: { input: PRICE_IN_PER_M_LIGHT, output: PRICE_OUT_PER_M_LIGHT },
    },
    limits: {
      max_req_per_min: MAX_REQ_PER_MIN,
      max_msg_chars: MAX_MSG_CHARS,
      max_completion_tokens_limits: { strong: MAX_TOKENS_STRONG, light: MAX_TOKENS_LIGHT },
      max_state_age_ms: MAX_STATE_AGE_MS,
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

    const sessionId = makeSessionId(req);
    const state = getState(sessionId);

    usage.day.requests++;
    usage.month.requests++;
    usage.lifetime.requests++;

    const deterministicCanon = tryCanonAnswer(trimmed, state);
    if (deterministicCanon && deterministicCanon !== "Registro insuficiente.") {
      saveState(sessionId, state);
      usage.last_error = null;
      return res.json({ reply: deterministicCanon });
    }

    const glossary = tryGlossaryAnswer(trimmed);
    if (glossary) {
      saveState(sessionId, state);
      usage.last_error = null;
      return res.json({ reply: glossary });
    }

    const character = tryCharacterAnswer(trimmed);
    if (character) {
      saveState(sessionId, state);
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

    const replyText = extractTextFromCompletion(completion) || buildSoftFallback(trimmed, state);
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
    saveState(sessionId, state);

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
      (err?.error?.code === "insufficient_quota" || err?.error?.type === "insufficient_quota")
    ) {
      return res.status(503).json({
        reply:
          "Canal temporalmente restringido. El sistema requiere recalibración de recursos. Reintenta más tarde.",
      });
    }

    return res.status(500).json({ reply: "Interferencia del sistema. Reintenta en unos segundos." });
  }
});

app.listen(PORT, () => {
  console.log("SERVER_JS_VERSION:", SERVER_VERSION);
  console.log(`Ecko-7 backend listening on :${PORT}`);
});
