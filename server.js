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
    .replace(/[¿?¡!.,;:()"“”]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizeText(s = "") {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’‘`´]/g, "'")
    .replace(/[^a-zA-Z0-9'\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function escapeRegExp(str = "") {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
      /^\s*[-–•]?\s*([A-Za-zÀ-ÿ0-9’'´\- ]{2,100})\s*:\s*(.+)\s*$/
    );
    if (m) {
      const term = normalizeGlossaryKey(m[1]);
      const def = (m[2] || "").trim();
      if (term && def) dict.set(term, def);
      continue;
    }

    // Caso B: término en línea y definición en siguiente línea
    const looksLikeTerm = /^[A-Za-zÀ-ÿ0-9’'´\- ]{2,60}$/.test(line);
    if (looksLikeTerm) {
      let j = i + 1;
      while (j < lines.length && !(lines[j] || "").trim()) j++;

      if (j < lines.length) {
        const defLine = (lines[j] || "").trim();
        const looksLikeHeading =
          defLine === defLine.toUpperCase() && defLine.length > 6;

        if (!looksLikeHeading && defLine.length > 5) {
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

function canonDef(term) {
  return CANON_DICT.get(normalizeGlossaryKey(term)) || null;
}

const CANON_INDEX = [
  {
    key: "fauciss",
    aliases: ["fauciss", "el fauciss", "los fauciss"],
    type: "species",
    classification: "criaturas bioingenierizadas",
    status: "abierto",
    summary:
      canonDef("fauciss") ||
      "Criaturas bioingenierizadas con cuerpo de águila cuadrúpeda y cabeza de lobo. Utilizadas como unidades de vigilancia, caza y recolección. Algunas muestran comportamiento emergente no previsto.",
  },
  {
    key: "theoblade",
    aliases: ["theoblade", "theoblade d'normaux", "theoblade d’normaux"],
    type: "character",
    classification: "anomalía emergente",
    status: "parcialmente clasificado",
    summary:
      canonDef("theoblade") ||
      "Individuo asociado a una anomalía emergente dentro del sistema de Claire’s Island.",
  },
  {
    key: "caudiloux",
    aliases: [
      "caudiloux",
      "caudiloux ii",
      "caudiloux ii d'magnanis",
      "caudiloux ii d’magnanis",
    ],
    type: "character",
    classification: "autoridad gubernamental",
    status: "abierto",
    summary:
      canonDef("caudiloux") ||
      "Regente de Isla D'Claire y máxima autoridad política visible dentro de la estructura de gobierno de la isla.",
  },
  {
    key: "kathy",
    aliases: ["kathy", "kathy d'pounier", "kathy d’pounier"],
    type: "character",
    classification: "estudiante del Instituto",
    status: "abierto",
    summary:
      canonDef("kathy") ||
      "Estudiante del Instituto de Estudios Especiales. Posee una sensibilidad emocional y cognitiva que produce resonancias detectables dentro de la red HyperT.",
  },
  {
    key: "susan",
    aliases: ["susan", "susan d'pounier", "susan d’pounier"],
    type: "character",
    classification: "residente civil",
    status: "abierto",
    summary:
      canonDef("susan") ||
      "Amiga de Kathy. Observadora analítica del funcionamiento social de la isla y de las dinámicas del sistema HyperT.",
  },
  {
    key: "exta",
    aliases: ["exta", "éxta"],
    type: "character",
    classification: "entidad de interés sistémico",
    status: "parcialmente clasificado",
    summary:
      canonDef("exta") || canonDef("éxta") ||
      "Individuo vinculado a fenómenos perceptivos y resonancias biotecnológicas dentro del entorno de Isla D'Claire. Su interacción con otros individuos genera variaciones detectables en la red emocional del sistema.",
  },
  {
    key: "freed scient",
    aliases: ["scient", "freed scient"],
    type: "character",
    classification: "investigador senior",
    status: "parcialmente clasificado",
    summary:
      canonDef("freed scient") || canonDef("scient") ||
      "Investigador vinculado al estudio de fenómenos históricos y científicos asociados a la Espiral del Tiempo.",
  },
  {
    key: "goreman",
    aliases: ["goreman", "veg goreman"],
    type: "character",
    classification: "autoridad política",
    status: "abierto",
    summary:
      canonDef("goreman") || canonDef("veg goreman") ||
      "Senador influyente dentro de la estructura política de Clairetown. Participa activamente en decisiones estratégicas del Senado.",
  },
  {
    key: "clyma",
    aliases: ["clyma"],
    type: "character",
    classification: "residente civil",
    status: "parcialmente clasificado",
    summary:
      canonDef("clyma") ||
      "Figura emocionalmente intensa asociada a procesos de memoria, identidad y resonancia sistémica dentro de la red social de la isla.",
  },
  {
    key: "trianoux",
    aliases: ["trianoux"],
    type: "character",
    classification: "operador político",
    status: "parcialmente clasificado",
    summary:
      canonDef("trianoux") ||
      "Actor político implicado en conflictos de poder dentro de la estructura gubernamental de la isla. Efectivo de la Guardia Postirana.",
  },
  {
    key: "autiloux",
    aliases: ["autiloux"],
    type: "character",
    classification: "operador estratégico",
    status: "parcialmente clasificado",
    summary:
      canonDef("autiloux") ||
      "Jefe de la Guardia Postirana. Individuo asociado a operaciones estratégicas dentro de las dinámicas de poder que rodean Isla D'Claire. Su perfil combina observación analítica y participación en eventos críticos del sistema.",
  },
  {
    key: "ecolibrium",
    aliases: ["ecolibrium"],
    type: "organization",
    classification: "estructura corporativa sistémica",
    status: "parcialmente clasificado",
    summary:
      canonDef("ecolibrium") ||
      "Entidad vinculada a la administración profunda de procesos biotecnológicos, equilibrio operativo y control sistémico en el universo de Claire’s Island.",
  },
  {
    key: "clairetown",
    aliases: ["clairetown", "claire town"],
    type: "place",
    classification: "núcleo urbano",
    status: "abierto",
    summary:
      canonDef("clairetown") || canonDef("claire town") ||
      "Centro urbano principal de Isla D'Claire, donde convergen administración, vida civil, protocolos sociales y vigilancia sistémica.",
  },
  {
    key: "instituto",
    aliases: ["instituto", "el instituto", "instituto de estudios especiales"],
    type: "place",
    classification: "centro formativo y de control",
    status: "abierto",
    summary:
      canonDef("instituto") ||
      canonDef("instituto de estudios especiales") ||
      "Institución central dedicada a la formación, observación y modulación de individuos con valor sistémico dentro de Claire’s Island.",
  },
  {
    key: "hypert",
    aliases: ["hypert", "hyper t", "hyper-t"],
    type: "system",
    classification: "infraestructura neurotecnológica",
    status: "abierto",
    summary:
      canonDef("hypert") ||
      canonDef("hyper t") ||
      canonDef("hyper-t") ||
      "Red neurobiotecnológica que conecta percepción, vigilancia, conducta y transmisión de datos dentro de Claire’s Island.",
  },
  {
    key: "niveles hypert",
    aliases: [
      "niveles hypert",
      "niveles de hypert",
      "hypert niveles",
      "niveles del hypert",
    ],
    type: "system",
    classification: "segmentación operativa",
    status: "parcialmente clasificado",
    summary:
      canonDef("hypert niveles") ||
      canonDef("niveles hypert") ||
      canonDef("niveles de hypert") ||
      "Escalonamiento funcional interno de la red HyperT, asociado a distintos grados de acceso, percepción, intervención y modulación sistémica.",
  },
  {
    key: "espiral del tiempo",
    aliases: ["espiral del tiempo", "la espiral", "espiral"],
    type: "concept",
    classification: "fenómeno temporal",
    status: "parcialmente clasificado",
    summary:
      canonDef("espiral del tiempo") ||
      canonDef("espiral") ||
      "Fenómeno de alteración temporal y causal con efectos sobre memoria, identidad, continuidad histórica y comportamiento sistémico.",
  },
  {
    key: "bollards",
    aliases: ["bollards", "los bollards", "bollard"],
    type: "group",
    classification: "estructura de contención y control",
    status: "parcialmente clasificado",
    summary:
      canonDef("bollards") ||
      canonDef("bollard") ||
      "Conjunto de entidades o dispositivos vinculados a funciones de contención, custodia, filtrado y estabilidad dentro de la arquitectura sistémica de Claire’s Island.",
  },

    {
    key: "ecko-7",
    aliases: ["ecko 7", "ecko-7", "ecko7"],
    type: "system",
    classification: "inteligencia sistémica interna",
    status: "abierto",
    summary:
      canonDef("ecko-7") ||
      canonDef("ecko 7") ||
      "Inteligencia sistémica interna de Isla D'Claire, diseñada para recuperar, filtrar y entregar información autorizada sin romper los protocolos de confidencialidad.",
  },
  {
    key: "h p lander",
    aliases: ["h p lander", "hp lander", "h.p. lander", "h.p lander"],
    type: "character",
    classification: "registro metanarrativo",
    status: "parcialmente clasificado",
    summary:
      canonDef("h p lander") ||
      canonDef("hp lander") ||
      canonDef("h.p. lander") ||
      "Figura asociada a los márgenes del archivo narrativo y a fenómenos de integración incierta entre observador, autor y sistema.",
  },
  {
    key: "tt",
    aliases: ["tt", "mr tt", "teddy tannenbaum"],
    type: "character",
    classification: "agente corporativo",
    status: "parcialmente clasificado",
    summary:
      canonDef("tt") ||
      canonDef("mr tt") ||
      canonDef("teddy tannenbaum") ||
      "Figura asociada a operaciones de influencia, supervisión y convergencia entre espectáculo, control y poder corporativo.",
  },
];

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
  return /\b(que es|que son|quien es|quienes son|define|definir|hablame de|que sabes de|informacion sobre|info sobre|datos de|dime sobre|para que sirve|como funciona|como opera|cual es su funcion|funcion|que hace)\b/.test(
    norm
  );
}

function extractTarget(norm) {
  const patterns = [
    /\b(?:que es|que son|quien es|quienes son|define|definir|hablame de|que sabes de|informacion sobre|info sobre|datos de|dime sobre|para que sirve|como funciona|como opera|cual es su funcion|funcion|que hace)\s+(.+?)\s*$/,
  ];

  for (const p of patterns) {
    const m = norm.match(p);
    if (m?.[1]) {
      return normalizeGlossaryKey(
        m[1].replace(/^(un|una|el|la|los|las)\s+/, "").trim()
      );
    }
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

  // 2. exact boundary match in full query
  for (const entry of CANON_INDEX) {
    for (const alias of entry.aliases) {
      const aliasNorm = normalizeGlossaryKey(alias);
      const re = new RegExp(`\\b${escapeRegExp(aliasNorm)}\\b`, "i");
      if (re.test(norm)) return entry;
    }
  }

  // 3. exact dictionary match
  if (CANON_DICT.has(target)) {
    return buildConceptEntry(target, CANON_DICT.get(target));
  }

  // 4. first token match
  const base = target.split(/\s+/)[0];
  if (CANON_DICT.has(base)) {
    return buildConceptEntry(base, CANON_DICT.get(base));
  }

  // 5. partial match prioritizing longer aliases
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

function formatCanonReply(entry, intent = "generic") {
  const name = entry.key.toUpperCase();

  if (intent === "identity" && entry.type === "character") {
    return `Registro recuperado. ${name}: ${entry.summary} Clasificación sistémica: ${entry.classification}. Estado del archivo: ${entry.status}.`;
  }

  if (intent === "function") {
    return `Registro confirmado. ${name}: función principal dentro del sistema: ${entry.summary} Clasificación sistémica: ${entry.classification}. Estado del archivo: ${entry.status}. ¿Deseas ampliar su relación con otros elementos de Claire’s Island?`;
  }

  if (intent === "about") {
    return `Registro recuperado. ${name}: ${entry.summary} Clasificación sistémica: ${entry.classification}. Estado del archivo: ${entry.status}. ¿Deseas ampliar el archivo?`;
  }

  return `Registro confirmado. ${name}: ${entry.summary} Clasificación sistémica: ${entry.classification}. Estado del archivo: ${entry.status}. ¿Deseas su función práctica dentro del sistema?`;
}

function tryCanonAnswer(userText) {
  const norm = normalizeGlossaryKey(userText);
  if (!norm) return null;

  if (wantsSpoiler(norm)) {
    return confidentialityReply();
  }

  if (!looksLikeCanonQuery(norm)) {
    return null;
  }

  const intent = detectIntent(norm);
  const target = extractTarget(norm);
  const entry = findCanonEntry(target, norm);

  if (!entry) return null;

  return formatCanonReply(entry, intent);
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
      version: "2026-03-10 ecko7_unified_v2",
      canon_chars: CANON_PACK ? CANON_PACK.length : 0,
      canon_dict_size: CANON_DICT ? CANON_DICT.size : 0,
      canon_index_size: CANON_INDEX.length,
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

    // Respuesta determinística unificada ECKO-7
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
  console.log("SERVER_JS_VERSION: 2026-03-10 ecko7_unified_v2");
  console.log(`Ecko-7 backend listening on :${PORT}`);
});