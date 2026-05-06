import { Router, type IRouter, type Request, type Response } from "express";
import { PDFParse } from "pdf-parse";
import { z } from "zod";

const router: IRouter = Router();

const MAX_PDF_BYTES = 25 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 20;
const CHUNK_SIZE = 1600;
const CHUNK_OVERLAP = 260;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const DatasheetAnswerRequest = z.object({
  datasheet_url: z.string().trim().min(1, "datasheet_url is required"),
  question: z.string().trim().min(1, "question is required"),
});

type Confidence = "high" | "medium" | "low";

interface PdfPage {
  page: number;
  text: string;
}

interface CachedDatasheet {
  pages: PdfPage[];
  textLength: number;
  sizeBytes: number;
  cachedAt: number;
}

interface TextChunk {
  id: string;
  page: number;
  text: string;
}

interface ScoredChunk extends TextChunk {
  score: number;
}

interface EvidenceSnippet {
  text: string;
  page: number;
  score: number;
}

const datasheetCache = new Map<string, CachedDatasheet>();

const SYNONYMS: Record<string, string[]> = {
  voltage: ["voltage", "supply", "vcc", "vdd", "vin", "input voltage", "operating voltage"],
  current: ["current", "supply current", "drain current", "output current"],
  power: ["power", "watt", "watts", "power dissipation", "rated power"],
  temperature: ["temperature", "operating temperature", "ambient", "storage temperature"],
  speed: ["speed", "rpm", "rotation", "rated speed", "motor speed"],
  torque: ["torque", "holding torque", "detent torque", "load torque"],
  force: ["force", "load", "thrust"],
  pressure: ["pressure", "psi", "bar", "pa", "kpa", "mpa"],
  flow: ["flow", "flow rate", "lpm", "gpm", "cfm"],
  weight: ["weight", "mass", "gram", "grams", "kilogram", "pound"],
  dimension: [
    "dimension",
    "dimensions",
    "size",
    "length",
    "width",
    "height",
    "diameter",
    "shaft",
    "bore",
    "thread",
    "hole",
    "pitch",
    "spacing",
  ],
  package: ["package", "case", "footprint", "mounting", "enclosure", "housing"],
  material: ["material", "materials", "body", "housing", "insulation", "plating"],
  connector: ["connector", "connectors", "connection", "terminal", "terminals", "header", "plug"],
  interface: ["interface", "protocol", "communication", "i2c", "spi", "uart", "rs232", "rs485", "usb", "can", "ethernet", "pwm"],
  output: ["output", "outputs", "signal", "analog output", "digital output"],
  input: ["input", "inputs", "control input", "logic input"],
  rating: ["rating", "rated", "absolute maximum", "maximum", "minimum", "recommended", "limit"],
  accuracy: ["accuracy", "precision", "error", "linearity", "repeatability"],
  resolution: ["resolution", "sensitivity", "scale", "step angle"],
  timing: ["timing", "delay", "rise time", "fall time", "pulse", "settling time"],
  thermal: ["thermal", "heat", "junction", "case temperature", "thermal resistance"],
  environmental: ["environmental", "humidity", "vibration", "shock", "ip rating", "protection"],
  compliance: ["compliance", "certification", "rohs", "reach", "ul", "ce"],
  pin: ["pin", "pins", "pinout", "terminal", "positions"],
  frequency: ["frequency", "clock", "bandwidth"],
  capacitance: ["capacitance", "capacitor"],
  resistance: ["resistance", "resistor"],
  tolerance: ["tolerance", "accuracy"],
  wiring: [
    "wiring",
    "wire",
    "wires",
    "lead",
    "leads",
    "connection",
    "connections",
    "connect",
    "connected",
    "drive",
    "coil",
    "phase",
    "parallel",
    "series",
    "color",
    "colors",
    "a+",
    "a-",
    "b+",
    "b-",
  ],
};

const STOP_WORDS = new Set([
  "what",
  "is",
  "the",
  "a",
  "an",
  "of",
  "for",
  "this",
  "that",
  "part",
  "value",
  "give",
  "show",
  "find",
  "tell",
  "me",
  "please",
  "does",
  "do",
  "in",
  "on",
  "from",
  "datasheet",
  "spec",
  "specification",
  "how",
]);

const UNIT_PATTERN =
  /[-+]?\d+(?:\.\d+)?\s*(?:to|through|[-–—~])?\s*[-+]?\d*(?:\.\d+)?\s*(?:mV|kV|V|mA|uA|µA|A|°C|deg(?:rees)?\s*C|GHz|MHz|kHz|Hz|MΩ|kΩ|Ω|Mohm|kohm|ohm|pF|nF|uF|µF|F|rpm|mW|W)\b/i;

const VALUE_PATTERN =
  /[-+]?\d+(?:\.\d+)?\s*(?:to|through|[-–—~])\s*[-+]?\d+(?:\.\d+)?\s*(?:mV|kV|V|mA|uA|µA|A|°C|deg(?:rees)?\s*C|GHz|MHz|kHz|Hz|MΩ|kΩ|Ω|Mohm|kohm|ohm|pF|nF|uF|µF|F|rpm|mW|W)\b|[-+]?\d+(?:\.\d+)?\s*(?:mV|kV|V|mA|uA|µA|A|°C|deg(?:rees)?\s*C|GHz|MHz|kHz|Hz|MΩ|kΩ|Ω|Mohm|kohm|ohm|pF|nF|uF|µF|F|rpm|mW|W)\b/i;
const BROAD_UNIT_PATTERN =
  /[-+]?\d+(?:\.\d+)?\s*(?:to|through|[-â€“â€”~])?\s*[-+]?\d*(?:\.\d+)?\s*(?:mm|cm|in|inch|inches|mil|g|kg|lb|lbs|oz|N|mN|N\s*cm|N\s*m|oz\s*in|lb\s*in|psi|bar|Pa|kPa|MPa|lpm|gpm|cfm|%|RH|IP\d{2})\b/i;
const BROAD_VALUE_PATTERN =
  /[-+]?\d+(?:\.\d+)?\s*(?:to|through|[-â€“â€”~])\s*[-+]?\d+(?:\.\d+)?\s*(?:mm|cm|in|inch|inches|mil|g|kg|lb|lbs|oz|N|mN|N\s*cm|N\s*m|oz\s*in|lb\s*in|psi|bar|Pa|kPa|MPa|lpm|gpm|cfm|%|RH|IP\d{2})\b|[-+]?\d+(?:\.\d+)?\s*(?:mm|cm|in|inch|inches|mil|g|kg|lb|lbs|oz|N|mN|N\s*cm|N\s*m|oz\s*in|lb\s*in|psi|bar|Pa|kPa|MPa|lpm|gpm|cfm|%|RH|IP\d{2})\b/i;
const CONNECTION_HEADING_PATTERN =
  /\b(?:wiring|wire connections?|lead wires?|pinout|terminals?|connectors?|cabling|hook\s*up|connection diagram|parallel connection|series connection|\d+\s*-\s*(?:lead|wire|pin)s?|\d+\s*(?:lead|wire|pin)s?)\b/i;
const CONNECTION_LINE_PATTERN =
  /\b(?:drive|phase|coil|winding|terminal|pin|lead|wire|connector|channel|output|input)\s*[a-z0-9+\-/]*\s*(?:=|:|to\b)|\b(?:[a-z][+-]|\d+[a-z]?|p\d+)\s*(?:=|:)\s*[\w/+ -]+|\bconnect(?:ed)?\b.+\b(?:to|with|together|drive|terminal|pin|lead|wire|connector)\b|\b(?:red|black|white|blue|green|yellow|orange|brown|gray|grey|violet|purple)\b/i;
const STRUCTURED_LINE_PATTERN = /[:=]|\t| {2,}|[-â€“â€”]\s+\S/;
const SPEC_SECTION_PATTERN =
  /\b(?:absolute maximum|recommended operating|electrical characteristics?|mechanical characteristics?|mechanical dimensions?|dimensions?|pin configuration|pin description|pinout|terminal functions?|connector|wiring|specifications?|ratings?|performance|timing|thermal|environmental|materials?|mounting|installation|outline|package|ordering information|features?)\b/i;
const DIMENSION_HEADING_PATTERN =
  /\b(?:dimensions?|mechanical dimensions?|outline drawings?|outline dimensions?|mounting dimensions?|mounting pattern|shaft dimensions?|case dimensions?|package dimensions?|footprint|mechanical drawing)\b/i;
const DIMENSION_LINE_PATTERN =
  /\b(?:length|width|height|diameter|dia\.?|od|id|shaft|bore|hole|holes|thread|pitch|spacing|mounting|mount|flange|radius|thick(?:ness)?|depth|overall|body|case|footprint|centerline|centers?|clearance)\b/i;
const TABLE_HEADER_PATTERN =
  /\b(?:parameter|symbol|condition|conditions|min|typ|typical|max|maximum|unit|units|value|values|rating|model|part(?:\s*number)?|description)\b/i;
const EXTRA_SPEC_VALUE_PATTERN =
  /\b(?:IP\d{2}[A-Z]?|NEMA\s*\d+[A-Z]?|[-+]?\d+(?:\.\d+)?\s*(?:N[-\s]*cm|N[-\s]*m|mN[-\s]*m|oz[-\s]*in|lb[-\s]*in|kgf[-\s]*cm|mm|cm|in|inch|inches|mil|um|micron|g|kg|lb|lbs|oz|N|mN|psi|bar|Pa|kPa|MPa|lpm|gpm|cfm|sccm|%RH|%|rpm|rps|deg|degree|steps?\/rev|VDC|VAC|V|mV|kV|A|mA|uA|Hz|kHz|MHz|GHz|W|mW|ohm|kohm|Mohm|pF|nF|uF|F)\b)/i;
const EXTRA_NUMERIC_VALUE_PATTERN =
  /\b[-+]?\d+(?:\.\d+)?\s*(?:N[-\s]*cm|N[-\s]*m|mN[-\s]*m|oz[-\s]*in|lb[-\s]*in|kgf[-\s]*cm|mm|cm|in|inch|inches|mil|um|micron|g|kg|lb|lbs|oz|N|mN|psi|bar|Pa|kPa|MPa|lpm|gpm|cfm|sccm|%RH|%|rpm|rps|deg|degree|steps?\/rev|VDC|VAC|V|mV|kV|A|mA|uA|Hz|kHz|MHz|GHz|W|mW|ohm|kohm|Mohm|pF|nF|uF|F)\b/i;
const SPECIAL_RATING_VALUE_PATTERN = /\b(?:IP\d{2}[A-Z]?|NEMA\s*\d+[A-Z]?)\b/i;
const SYMBOL_VALUE_PATTERN =
  /\b[A-Z][A-Z0-9]{0,4}\b\s*(?:=|:)\s*[-+]?\d|\b(?:A|B|C|D|E|F|G|H|L|W|P|T)\s+[-+]?\d+(?:\.\d+)?\b/;

function normalizeText(text: string): string {
  return text
    .replace(/\r/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeTokenText(text: string): string {
  return text
    .toLowerCase()
    .replace(/µ/g, "u")
    .replace(/ω/g, "ohm")
    .replace(/Ω/g, "ohm")
    .replace(/°c/g, " degc ");
}

function tokenize(text: string): string[] {
  return normalizeTokenText(text)
    .replace(/[^a-z0-9.+-]+/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

function expandQuestionTerms(question: string): Set<string> {
  const terms = new Set(tokenize(question));
  const normalizedQuestion = normalizeTokenText(question);

  for (const aliases of Object.values(SYNONYMS)) {
    const matchesGroup = aliases.some((alias) => normalizedQuestion.includes(normalizeTokenText(alias)));
    if (!matchesGroup) continue;

    for (const alias of aliases) {
      tokenize(alias).forEach((token) => terms.add(token));
    }
  }

  return terms;
}

function questionAliases(question: string): string[] {
  const normalizedQuestion = normalizeTokenText(question);
  return Object.values(SYNONYMS)
    .filter((aliases) => aliases.some((alias) => normalizedQuestion.includes(normalizeTokenText(alias))))
    .flat();
}

function isLikelyNumericSpec(question: string): boolean {
  const normalizedQuestion = normalizeTokenText(question);
  return (
    /\b(value|voltage|current|temperature|frequency|capacitance|resistance|tolerance|rpm|power|watt|supply|vcc|vdd|vin|speed|torque|dimension|dimensions|size|length|width|height|diameter|pressure|flow|weight|mass|force|load|accuracy|resolution|timing|delay)\b/.test(
      normalizedQuestion,
    ) ||
    UNIT_PATTERN.test(question) ||
    BROAD_UNIT_PATTERN.test(question)
  );
}

function isConnectionQuestion(question: string): boolean {
  return /\b(wiring|wire|wires|lead|leads|connection|connect|connected|pinout|terminal|terminals|connector|connectors|coil|phase|drive|parallel|series)\b/i.test(
    question,
  );
}

function isMultiValueQuestion(question: string): boolean {
  return /\b(dimensions?|pinout|pins?|terminals?|connectors?|wiring|mechanical|electrical characteristics?|ratings?|table|package|mounting|interface|timing|thermal|materials?)\b/i.test(
    question,
  );
}

function isDimensionQuestion(question: string): boolean {
  return /\b(dimensions?|dimension|mechanical|outline|drawing|mounting|shaft|length|width|height|diameter|bore|hole|thread|pitch|spacing|size|footprint)\b/i.test(
    question,
  );
}

function isBroadSectionQuestion(question: string): boolean {
  return /\b(specs?|specifications?|ratings?|characteristics?|dimensions?|mechanical|electrical|pinout|pins?|terminals?|connectors?|wiring|package|mounting|interface|timing|thermal|environmental|materials?)\b/i.test(
    question,
  );
}

function hasSpecValue(text: string): boolean {
  return UNIT_PATTERN.test(text) || BROAD_UNIT_PATTERN.test(text) || EXTRA_SPEC_VALUE_PATTERN.test(text);
}

function isTableLikeLine(line: string): boolean {
  return (
    STRUCTURED_LINE_PATTERN.test(line) ||
    TABLE_HEADER_PATTERN.test(line) ||
    SYMBOL_VALUE_PATTERN.test(line) ||
    hasSpecValue(line) ||
    (/\d/.test(line) && /\s{2,}|;|,/.test(line))
  );
}

function validateDatasheetUrl(value: string): URL {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error("datasheet_url must be a valid URL");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("datasheet_url must use http or https");
  }

  return url;
}

function isAllowedContentType(contentType: string | null, url: URL): boolean {
  if (!contentType) return true;

  const type = contentType.toLowerCase();
  if (
    type.includes("application/pdf") ||
    type.includes("application/x-pdf") ||
    type.includes("application/octet-stream") ||
    type.includes("binary/octet-stream")
  ) {
    return true;
  }

  return url.pathname.toLowerCase().endsWith(".pdf") && !type.includes("text/html");
}

async function readLimitedBody(response: globalThis.Response): Promise<Buffer> {
  if (!response.body) {
    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength > MAX_PDF_BYTES) {
      throw new Error("PDF too large");
    }
    return Buffer.from(arrayBuffer);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      total += value.byteLength;
      if (total > MAX_PDF_BYTES) {
        throw new Error("PDF too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks);
}

async function downloadPdf(url: URL): Promise<Buffer> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/pdf,application/octet-stream;q=0.9,*/*;q=0.8",
    },
    redirect: "follow",
  });

  if (!response.ok) {
    throw new Error(`PDF download failure: ${response.status} ${response.statusText}`);
  }

  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_PDF_BYTES) {
    throw new Error("PDF too large");
  }

  const contentType = response.headers.get("content-type");
  if (!isAllowedContentType(contentType, url)) {
    throw new Error(`Unsupported content type: ${contentType}`);
  }

  const buffer = await readLimitedBody(response);
  const header = buffer.subarray(0, 5).toString("utf8");
  if (header !== "%PDF-" && !isAllowedContentType(contentType, url)) {
    throw new Error(`Unsupported content type: ${contentType ?? "unknown"}`);
  }
  if (header !== "%PDF-" && contentType?.toLowerCase().includes("text/html")) {
    throw new Error("Unsupported content type: text/html");
  }

  return buffer;
}

async function parsePdf(buffer: Buffer): Promise<PdfPage[]> {
  const parser = new PDFParse({ data: new Uint8Array(buffer) });

  try {
    const result = await parser.getText();
    return result.pages
      .map((page) => ({
        page: page.num,
        text: normalizeText(page.text),
      }))
      .filter((page) => page.text.length > 0);
  } finally {
    await parser.destroy().catch(() => null);
  }
}

function putCache(key: string, value: CachedDatasheet): void {
  if (datasheetCache.size >= MAX_CACHE_ENTRIES) {
    const firstKey = datasheetCache.keys().next().value;
    if (firstKey) datasheetCache.delete(firstKey);
  }
  datasheetCache.set(key, value);
}

async function getDatasheet(url: URL): Promise<CachedDatasheet> {
  const cacheKey = url.href;
  const cached = datasheetCache.get(cacheKey);
  if (cached) return cached;

  const buffer = await downloadPdf(url);
  let pages: PdfPage[];

  try {
    pages = await parsePdf(buffer);
  } catch (err) {
    throw new Error(`PDF parse failure: ${err instanceof Error ? err.message : String(err)}`);
  }

  const textLength = pages.reduce((total, page) => total + page.text.length, 0);
  const cachedDatasheet = {
    pages,
    textLength,
    sizeBytes: buffer.byteLength,
    cachedAt: Date.now(),
  };

  putCache(cacheKey, cachedDatasheet);
  return cachedDatasheet;
}

function splitPageIntoChunks(page: PdfPage): TextChunk[] {
  const chunks: TextChunk[] = [];
  const text = page.text;

  if (text.length <= CHUNK_SIZE) {
    return [{ id: `${page.page}:0`, page: page.page, text }];
  }

  let start = 0;
  let index = 0;

  while (start < text.length) {
    const targetEnd = Math.min(start + CHUNK_SIZE, text.length);
    const softEnd = text.lastIndexOf("\n", targetEnd);
    const end = softEnd > start + 900 ? softEnd : targetEnd;
    const chunkText = text.slice(start, end).trim();

    if (chunkText) {
      chunks.push({ id: `${page.page}:${index}`, page: page.page, text: chunkText });
      index += 1;
    }

    if (end >= text.length) break;
    start = Math.max(0, end - CHUNK_OVERLAP);
  }

  return chunks;
}

function buildChunks(pages: PdfPage[]): TextChunk[] {
  return pages.flatMap(splitPageIntoChunks);
}

function scoreText(text: string, question: string, queryTerms: Set<string>, aliases: string[]): number {
  const chunkTokens = new Set(tokenize(text));
  const lowerText = normalizeTokenText(text);
  let score = 0;

  for (const token of queryTerms) {
    if (chunkTokens.has(token)) score += 2;
    else if (lowerText.includes(token)) score += 0.75;
  }

  for (const alias of aliases) {
    if (lowerText.includes(normalizeTokenText(alias))) score += 4;
  }

  if (isLikelyNumericSpec(question) && hasSpecValue(text)) {
    score += 3;
  }

  if (SPEC_SECTION_PATTERN.test(text)) {
    score += 1.5;
  }

  if (isDimensionQuestion(question) && (DIMENSION_LINE_PATTERN.test(text) || DIMENSION_HEADING_PATTERN.test(text))) {
    score += 3;
  }

  if (isBroadSectionQuestion(question) && isTableLikeLine(text)) {
    score += 1.25;
  }

  return score;
}

function scoreChunks(chunks: TextChunk[], question: string): ScoredChunk[] {
  const queryTerms = expandQuestionTerms(question);
  const aliases = questionAliases(question);

  return chunks
    .map((chunk) => ({
      ...chunk,
      score: scoreText(chunk.text, question, queryTerms, aliases),
    }))
    .filter((chunk) => chunk.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 12);
}

function clipSnippet(text: string, maxLength = 260): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, maxLength - 1).trim()}...`;
}

function splitIntoSnippetCandidates(text: string): string[] {
  const lines = text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const snippets: string[] = [];

  for (const line of lines) {
    if (line.length <= 360) {
      snippets.push(line);
      continue;
    }

    const sentences = line.split(/(?<=[.!?;])\s+/).filter(Boolean);
    if (sentences.length > 1) {
      snippets.push(...sentences);
      continue;
    }

    for (let start = 0; start < line.length; start += 260) {
      snippets.push(line.slice(start, start + 340));
    }
  }

  return snippets;
}

function extractEvidence(chunks: ScoredChunk[], question: string): EvidenceSnippet[] {
  if (isConnectionQuestion(question)) {
    const connectionEvidence = extractConnectionEvidence(chunks);
    if (connectionEvidence.length) return connectionEvidence;
  }

  if (isDimensionQuestion(question)) {
    const dimensionEvidence = extractDimensionEvidence(chunks);
    if (dimensionEvidence.length) return dimensionEvidence;
  }

  if (isBroadSectionQuestion(question)) {
    const sectionEvidence = extractSectionEvidence(chunks, question);
    if (sectionEvidence.length && sectionEvidence[0]!.score >= 5) {
      return sectionEvidence;
    }
  }

  const structuredEvidence = extractStructuredEvidence(chunks, question);
  if (structuredEvidence.length && structuredEvidence[0]!.score >= 5) {
    return structuredEvidence;
  }

  const queryTerms = expandQuestionTerms(question);
  const aliases = questionAliases(question);
  const candidates: EvidenceSnippet[] = [];

  for (const chunk of chunks) {
    for (const snippet of splitIntoSnippetCandidates(chunk.text)) {
      const score = scoreText(snippet, question, queryTerms, aliases);
      if (score <= 0) continue;

      candidates.push({
        text: clipSnippet(snippet),
        page: chunk.page,
        score: score + chunk.score * 0.1,
      });
    }
  }

  const seen = new Set<string>();
  return candidates
    .sort((a, b) => b.score - a.score)
    .filter((snippet) => {
      const key = snippet.text.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 5);
}

function extractDimensionEvidence(chunks: ScoredChunk[]): EvidenceSnippet[] {
  const candidates: EvidenceSnippet[] = [];

  for (const chunk of chunks) {
    const lines = chunk.text
      .split(/\n+/)
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter((line) => line.length >= 3 && line.length <= 500);

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";

      if (DIMENSION_HEADING_PATTERN.test(line)) {
        const block = [line];

        for (let offset = 1; offset <= 12; offset += 1) {
          const next = lines[index + offset] ?? "";
          if (!next) break;
          if (SPEC_SECTION_PATTERN.test(next) && !DIMENSION_LINE_PATTERN.test(next) && block.length > 1) break;

          if (
            DIMENSION_LINE_PATTERN.test(next) ||
            isTableLikeLine(next) ||
            /\b(?:mm|cm|inch|inches|dia|od|id)\b/i.test(next) ||
            (/^\(?\d+[.)]?\s+/.test(next) && /\d/.test(next))
          ) {
            block.push(next);
          }
        }

        candidates.push({
          text: clipSnippet(block.join("; "), 700),
          page: chunk.page,
          score: 38 + Math.min(block.length, 6) - index * 0.01,
        });
      }

      if ((DIMENSION_LINE_PATTERN.test(line) || SYMBOL_VALUE_PATTERN.test(line)) && (hasSpecValue(line) || isTableLikeLine(line))) {
        const next = lines[index + 1] ?? "";
        const combined = next && isTableLikeLine(next) && next.length <= 180 ? `${line}; ${next}` : line;

        candidates.push({
          text: clipSnippet(combined, 520),
          page: chunk.page,
          score: 22 - index * 0.01,
        });
      }
    }
  }

  const seen = new Set<string>();
  return candidates
    .sort((a, b) => b.score - a.score)
    .filter((snippet) => {
      const key = snippet.text.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 6);
}

function extractSectionEvidence(chunks: ScoredChunk[], question: string): EvidenceSnippet[] {
  const queryTerms = expandQuestionTerms(question);
  const aliases = questionAliases(question);
  const candidates: EvidenceSnippet[] = [];

  for (const chunk of chunks) {
    const lines = chunk.text
      .split(/\n+/)
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter((line) => line.length >= 3 && line.length <= 500);

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      const lineScore = scoreText(line, question, queryTerms, aliases);
      const looksRelevantSection =
        lineScore > 0 && (SPEC_SECTION_PATTERN.test(line) || TABLE_HEADER_PATTERN.test(line) || isTableLikeLine(line));

      if (!looksRelevantSection) continue;

      const block = [line];
      for (let offset = 1; offset <= 8; offset += 1) {
        const next = lines[index + offset] ?? "";
        if (!next) break;

        const nextScore = scoreText(next, question, queryTerms, aliases);
        if (nextScore > 0 || isTableLikeLine(next) || hasSpecValue(next)) {
          block.push(next);
          continue;
        }

        if (block.length >= 3) break;
      }

      candidates.push({
        text: clipSnippet(block.join("; "), 700),
        page: chunk.page,
        score: lineScore + chunk.score * 0.2 + Math.min(block.length, 5),
      });
    }
  }

  const seen = new Set<string>();
  return candidates
    .sort((a, b) => b.score - a.score)
    .filter((snippet) => {
      const key = snippet.text.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 6);
}

function extractStructuredEvidence(chunks: ScoredChunk[], question: string): EvidenceSnippet[] {
  const queryTerms = expandQuestionTerms(question);
  const aliases = questionAliases(question);
  const numericQuestion = isLikelyNumericSpec(question);
  const candidates: EvidenceSnippet[] = [];

  for (const chunk of chunks) {
    const lines = chunk.text
      .split(/\n+/)
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter((line) => line.length >= 4 && line.length <= 420);

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      let score = scoreText(line, question, queryTerms, aliases);

      if (score <= 0) continue;

      if (STRUCTURED_LINE_PATTERN.test(line)) score += 2;
      if (numericQuestion && hasSpecValue(line)) score += 3;
      if (SPEC_SECTION_PATTERN.test(line)) score += 1.5;
      if (line.length <= 160) score += 0.5;

      const next = lines[index + 1] ?? "";
      const combined =
        next &&
        line.length <= 90 &&
        !hasSpecValue(line) &&
        scoreText(next, question, queryTerms, aliases) > 0
          ? `${line}; ${next}`
          : line;

      candidates.push({
        text: clipSnippet(combined, 420),
        page: chunk.page,
        score: score + chunk.score * 0.15,
      });
    }
  }

  const seen = new Set<string>();
  return candidates
    .sort((a, b) => b.score - a.score)
    .filter((snippet) => {
      const key = snippet.text.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 5);
}

function extractConnectionEvidence(chunks: ScoredChunk[]): EvidenceSnippet[] {
  const candidates: EvidenceSnippet[] = [];

  for (const chunk of chunks) {
    const lines = chunk.text
      .split(/\n+/)
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(Boolean);

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";

      if (CONNECTION_HEADING_PATTERN.test(line)) {
        const block = [line];

        for (let offset = 1; offset <= 8; offset += 1) {
          const next = lines[index + offset] ?? "";
          if (!next) break;

          if (
            CONNECTION_LINE_PATTERN.test(next) ||
            CONNECTION_HEADING_PATTERN.test(next) ||
            /^drive\b/i.test(next) ||
            /^connect\b/i.test(next)
          ) {
            block.push(next);
          }
        }

        if (block.length > 1) {
          candidates.push({
            text: clipSnippet(block.join("; "), 520),
            page: chunk.page,
            score: 40 - index * 0.01,
          });
        }
      }

      if (CONNECTION_LINE_PATTERN.test(line)) {
        candidates.push({
          text: clipSnippet(line, 260),
          page: chunk.page,
          score: 20 - index * 0.01,
        });
      }
    }
  }

  const seen = new Set<string>();
  return candidates
    .sort((a, b) => b.score - a.score)
    .filter((snippet) => {
      const key = snippet.text.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 6);
}

function buildAnswer(evidence: EvidenceSnippet[], question: string): { answer: string | null; confidence: Confidence } {
  if (!evidence.length) {
    return { answer: null, confidence: "low" };
  }

  const numericQuestion = isLikelyNumericSpec(question);
  const sectionQuestion = isMultiValueQuestion(question);
  const bestWithUnit = evidence.find((item) => hasSpecValue(item.text));
  const best = numericQuestion && !sectionQuestion ? bestWithUnit : evidence[0];

  if (!best) {
    return { answer: null, confidence: "low" };
  }

  if (sectionQuestion) {
    const confidence: Confidence = best.score >= 8 ? "high" : best.score >= 4 ? "medium" : "low";
    if (confidence === "low") {
      return { answer: null, confidence };
    }

    return {
      answer: evidence
        .slice(0, 5)
        .map((item) => item.text)
        .join("\n"),
      confidence,
    };
  }

  if (numericQuestion) {
    const wantsSpecialRating = /\b(ip|nema|protection|enclosure|environmental|rating)\b/i.test(question);
    const value =
      best.text.match(VALUE_PATTERN)?.[0] ??
      best.text.match(EXTRA_NUMERIC_VALUE_PATTERN)?.[0] ??
      best.text.match(BROAD_VALUE_PATTERN)?.[0] ??
      (wantsSpecialRating ? best.text.match(SPECIAL_RATING_VALUE_PATTERN)?.[0] : null) ??
      null;
    if (!value) {
      return { answer: null, confidence: "low" };
    }

    const confidence: Confidence = best.score >= 9 ? "high" : best.score >= 5 ? "medium" : "low";

    if (isMultiValueQuestion(question) || evidence.some((item) => (item.text.match(BROAD_VALUE_PATTERN) ?? []).length > 1)) {
      return {
        answer: evidence
          .slice(0, 4)
          .map((item) => item.text)
          .join("\n"),
        confidence,
      };
    }

    return {
      answer: `${value} (${best.text})`,
      confidence,
    };
  }

  const confidence: Confidence = best.score >= 8 ? "high" : best.score >= 4 ? "medium" : "low";
  if (confidence === "low") {
    return { answer: null, confidence };
  }

  if (isConnectionQuestion(question)) {
    return {
      answer: evidence
        .slice(0, 4)
        .map((item) => item.text)
        .join("\n"),
      confidence,
    };
  }

  return {
    answer: evidence
      .slice(0, 3)
      .map((item) => item.text)
      .join("\n"),
    confidence,
  };
}

function errorStatus(message: string): number {
  if (message.includes("too large")) return 413;
  if (message.includes("Unsupported content type")) return 415;
  if (message.includes("PDF parse failure")) return 422;
  if (message.includes("PDF download failure")) return 502;
  return 500;
}

router.post("/datasheet-answer", async (req: Request, res: Response) => {
  const parsed = DatasheetAnswerRequest.safeParse(req.body);
  if (!parsed.success) {
    const fields = parsed.error.flatten().fieldErrors;
    res.status(400).json({
      error:
        fields.datasheet_url?.[0] ??
        fields.question?.[0] ??
        "Missing datasheet_url or question",
      details: fields,
    });
    return;
  }

  let url: URL;
  try {
    url = validateDatasheetUrl(parsed.data.datasheet_url);
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : "Invalid datasheet_url",
    });
    return;
  }

  try {
    const datasheet = await getDatasheet(url);

    if (datasheet.textLength === 0) {
      res.status(422).json({
        error: "No extractable text found in PDF",
      });
      return;
    }

    const chunks = buildChunks(datasheet.pages);
    const topChunks = scoreChunks(chunks, parsed.data.question);
    const evidence = extractEvidence(topChunks, parsed.data.question);
    const { answer, confidence } = buildAnswer(evidence, parsed.data.question);
    const pagesUsed = [...new Set(evidence.map((item) => item.page))];

    res.json({
      question: parsed.data.question,
      datasheet_url: url.href,
      answer,
      confidence,
      evidence: evidence.slice(0, 5).map((item) => item.text),
      source: "datasheet",
      pages_used: pagesUsed.length ? pagesUsed : undefined,
      error: answer ? undefined : "No relevant text found",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    req.log.warn({ err, datasheet_url: url.href }, "Datasheet answer failed");
    res.status(errorStatus(message)).json({
      error: message,
    });
  }
});

export default router;
