const fs = require("fs");
const path = require("path");

function safeReadText(filePath, fallback = "") {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (err) {
    console.error(`Error reading text file: ${filePath}`, err.message);
    return fallback;
  }
}

function safeReadJson(filePath, fallback = []) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    console.error(`Error reading JSON file: ${filePath}`, err.message);
    return fallback;
  }
}

function normalizeText(text) {
  return (text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // quita tildes
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(text) {
  return normalizeText(text)
    .split(" ")
    .filter(Boolean)
    .filter(token => token.length > 1);
}

function unique(arr) {
  return [...new Set(arr)];
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

class CanonRetrievalEngine {
  constructor(options = {}) {
    this.canonPath = options.canonPath || path.join(__dirname, "canon_pack.txt");
    this.indexPath = options.indexPath || path.join(__dirname, "canon_index.json");
    this.maxContextChars = options.maxContextChars || 1800;
    this.neighborPadding = options.neighborPadding || 220;

    this.canonPack = safeReadText(this.canonPath, "");
    this.index = safeReadJson(this.indexPath, []);

    this.normalizedIndex = this.index.map(entry => this.prepareEntry(entry));
  }

  prepareEntry(entry) {
    const title = entry.title || entry.id || "";
    const aliases = Array.isArray(entry.aliases) ? entry.aliases : [];
    const keywords = Array.isArray(entry.keywords) ? entry.keywords : [];

    return {
      ...entry,
      _titleNorm: normalizeText(title),
      _aliasesNorm: aliases.map(normalizeText),
      _keywordsNorm: keywords.map(normalizeText),
      _allTerms: unique([
        normalizeText(title),
        ...aliases.map(normalizeText),
        ...keywords.map(normalizeText)
      ]).filter(Boolean)
    };
  }

  reload() {
    this.canonPack = safeReadText(this.canonPath, "");
    this.index = safeReadJson(this.indexPath, []);
    this.normalizedIndex = this.index.map(entry => this.prepareEntry(entry));
  }

  retrieve(query, opts = {}) {
    const maxContextChars = opts.maxContextChars || this.maxContextChars;

    const queryNorm = normalizeText(query);
    const queryTokens = unique(tokenize(query));

    if (!queryNorm) {
      return this.emptyResult("empty_query");
    }

    const ranked = this.rankEntries(queryNorm, queryTokens);

    if (!ranked.length || ranked[0].score <= 0) {
      const fallback = this.retrieveFromRawCanon(queryNorm, queryTokens, maxContextChars);
      if (fallback) return fallback;
      return this.emptyResult("no_match");
    }

    const best = ranked[0];
    const context = this.extractContext(best.entry, maxContextChars);

    if (!context || !context.trim()) {
      const fallback = this.retrieveFromRawCanon(queryNorm, queryTokens, maxContextChars);
      if (fallback) return fallback;
      return this.emptyResult("empty_context");
    }

    return {
      ok: true,
      strategy: "indexed",
      query,
      normalizedQuery: queryNorm,
      topScore: best.score,
      matchedEntry: {
        id: best.entry.id || null,
        title: best.entry.title || null,
        type: best.entry.type || null
      },
      alternatives: ranked.slice(1, 4).map(x => ({
        id: x.entry.id || null,
        title: x.entry.title || null,
        type: x.entry.type || null,
        score: x.score
      })),
      context
    };
  }

  rankEntries(queryNorm, queryTokens) {
    const results = [];

    for (const entry of this.normalizedIndex) {
      let score = 0;

      for (const term of entry._allTerms) {
        if (!term) continue;

        if (queryNorm === term) {
          score += 100;
        }

        if (queryNorm.includes(term) && term.length > 2) {
          score += 40;
        }

        if (term.includes(queryNorm) && queryNorm.length > 2) {
          score += 20;
        }
      }

      for (const token of queryTokens) {
        if (entry._titleNorm.split(" ").includes(token)) {
          score += 20;
        }

        if (entry._aliasesNorm.some(alias => alias.split(" ").includes(token))) {
          score += 12;
        }

        if (entry._keywordsNorm.includes(token)) {
          score += 8;
        } else if (entry._keywordsNorm.some(k => k.includes(token))) {
          score += 4;
        }
      }

      const phraseBoosts = [
        ["quien es", "character", 12],
        ["who is", "character", 12],
        ["donde", "location", 10],
        ["where", "location", 10],
        ["que es", "technology", 10],
        ["what is", "technology", 10]
      ];

      for (const [phrase, type, boost] of phraseBoosts) {
        if (queryNorm.includes(phrase) && entry.type === type) {
          score += boost;
        }
      }

      if (score > 0) {
        results.push({ entry, score });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results;
  }

  extractContext(entry, maxContextChars) {
    if (
      typeof entry.start === "number" &&
      typeof entry.end === "number" &&
      entry.start >= 0 &&
      entry.end > entry.start
    ) {
      const start = Math.max(0, entry.start - this.neighborPadding);
      const end = Math.min(this.canonPack.length, entry.end + this.neighborPadding);

      return this.trimNicely(this.canonPack.slice(start, end), maxContextChars);
    }

    if (entry.fragment) {
      return this.trimNicely(entry.fragment, maxContextChars);
    }

    if (entry.title) {
      return this.extractByHeading(entry.title, maxContextChars);
    }

    return "";
  }

  extractByHeading(title, maxContextChars) {
    if (!this.canonPack || !title) return "";

    const pattern = new RegExp(
      `(^|\\n)\\s*${escapeRegExp(title)}\\s*[:\\n-]`,
      "i"
    );

    const match = pattern.exec(this.canonPack);
    if (!match) return "";

    const start = match.index;
    const end = Math.min(this.canonPack.length, start + maxContextChars + 600);
    return this.trimNicely(this.canonPack.slice(start, end), maxContextChars);
  }

  retrieveFromRawCanon(queryNorm, queryTokens, maxContextChars) {
    if (!this.canonPack) return null;

    const paragraphs = this.canonPack
      .split(/\n\s*\n/)
      .map(p => p.trim())
      .filter(Boolean);

    let bestParagraph = null;
    let bestScore = 0;

    for (const paragraph of paragraphs) {
      const pNorm = normalizeText(paragraph);
      let score = 0;

      if (pNorm.includes(queryNorm) && queryNorm.length > 2) {
        score += 30;
      }

      for (const token of queryTokens) {
        if (pNorm.includes(token)) {
          score += 3;
        }
      }

      if (score > bestScore) {
        bestScore = score;
        bestParagraph = paragraph;
      }
    }

    if (!bestParagraph || bestScore <= 0) return null;

    return {
      ok: true,
      strategy: "raw_scan",
      query: queryNorm,
      topScore: bestScore,
      matchedEntry: null,
      alternatives: [],
      context: this.trimNicely(bestParagraph, maxContextChars)
    };
  }

  trimNicely(text, maxChars) {
    if (!text) return "";

    const clean = text.replace(/\n{3,}/g, "\n\n").trim();
    if (clean.length <= maxChars) return clean;

    let sliced = clean.slice(0, maxChars);

    const lastPeriod = Math.max(
      sliced.lastIndexOf(". "),
      sliced.lastIndexOf("\n"),
      sliced.lastIndexOf("; "),
      sliced.lastIndexOf(": ")
    );

    if (lastPeriod > Math.floor(maxChars * 0.6)) {
      sliced = sliced.slice(0, lastPeriod + 1);
    }

    return sliced.trim();
  }

  emptyResult(reason) {
    return {
      ok: false,
      strategy: "none",
      reason,
      matchedEntry: null,
      alternatives: [],
      context: ""
    };
  }
}

module.exports = { CanonRetrievalEngine, normalizeText, tokenize };