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
  temperature: ["temperature", "operating temperature", "ambient"],
  package: ["package", "case", "footprint", "mounting"],
  pin: ["pin", "pins", "pinout", "terminal", "positions"],
  frequency: ["frequency", "clock", "bandwidth"],
  capacitance: ["capacitance", "capacitor"],
  resistance: ["resistance", "resistor"],
  tolerance: ["tolerance", "accuracy"],
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
]);

const UNIT_PATTERN =
  /[-+]?\d+(?:\.\d+)?\s*(?:to|through|[-–—~])?\s*[-+]?\d*(?:\.\d+)?\s*(?:mV|kV|V|mA|uA|µA|A|°C|deg(?:rees)?\s*C|GHz|MHz|kHz|Hz|MΩ|kΩ|Ω|Mohm|kohm|ohm|pF|nF|uF|µF|F|rpm|mW|W)\b/i;

const VALUE_PATTERN =
  /[-+]?\d+(?:\.\d+)?\s*(?:to|through|[-–—~])\s*[-+]?\d+(?:\.\d+)?\s*(?:mV|kV|V|mA|uA|µA|A|°C|deg(?:rees)?\s*C|GHz|MHz|kHz|Hz|MΩ|kΩ|Ω|Mohm|kohm|ohm|pF|nF|uF|µF|F|rpm|mW|W)\b|[-+]?\d+(?:\.\d+)?\s*(?:mV|kV|V|mA|uA|µA|A|°C|deg(?:rees)?\s*C|GHz|MHz|kHz|Hz|MΩ|kΩ|Ω|Mohm|kohm|ohm|pF|nF|uF|µF|F|rpm|mW|W)\b/i;

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
    /\b(value|voltage|current|temperature|frequency|capacitance|resistance|tolerance|rpm|power|watt|supply|vcc|vdd|vin)\b/.test(
      normalizedQuestion,
    ) || UNIT_PATTERN.test(question)
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

  if (isLikelyNumericSpec(question) && UNIT_PATTERN.test(text)) {
    score += 3;
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
    .slice(0, 5);
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

function buildAnswer(evidence: EvidenceSnippet[], question: string): { answer: string | null; confidence: Confidence } {
  if (!evidence.length) {
    return { answer: null, confidence: "low" };
  }

  const numericQuestion = isLikelyNumericSpec(question);
  const bestWithUnit = evidence.find((item) => UNIT_PATTERN.test(item.text));
  const best = numericQuestion ? bestWithUnit : evidence[0];

  if (!best) {
    return { answer: null, confidence: "low" };
  }

  if (numericQuestion) {
    const value = best.text.match(VALUE_PATTERN)?.[0] ?? null;
    if (!value) {
      return { answer: null, confidence: "low" };
    }

    const confidence: Confidence = best.score >= 9 ? "high" : best.score >= 5 ? "medium" : "low";
    return {
      answer: `${value} (${best.text})`,
      confidence,
    };
  }

  const confidence: Confidence = best.score >= 8 ? "high" : best.score >= 4 ? "medium" : "low";
  if (confidence === "low") {
    return { answer: null, confidence };
  }

  return {
    answer: best.text,
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
      evidence: evidence.slice(0, 2).map((item) => item.text),
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
