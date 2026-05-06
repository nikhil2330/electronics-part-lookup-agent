import { execSync } from "node:child_process";
import { Router, type IRouter, type Request, type Response } from "express";

const router: IRouter = Router();

const MOUSER_BASE = "https://api.mouser.com/api/v1";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function mouserPost(
  req: Request,
  path: string,
  body: object,
): Promise<{ data: unknown; status: number }> {
  const apiKey = process.env.MOUSER_API_KEY;
  if (!apiKey) {
    return { data: { error: "Missing MOUSER_API_KEY environment variable" }, status: 500 };
  }

  const url = `${MOUSER_BASE}${path}?apiKey=${encodeURIComponent(apiKey)}`;
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(25_000),
    });
    return { data: await r.json(), status: r.status };
  } catch (err) {
    req.log.error({ err }, "Mouser request failed");
    return {
      data: { error: "Mouser request failed", details: err instanceof Error ? err.message : String(err) },
      status: 500,
    };
  }
}

interface PriceBreak {
  Quantity?: number;
  Price?: string;
  Currency?: string;
  [key: string]: unknown;
}

function cleanMoney(priceBreaks: PriceBreak[] | null | undefined) {
  if (!priceBreaks) return [];
  return priceBreaks.slice(0, 5).map((p) => ({
    quantity: p.Quantity,
    price: p.Price,
    currency: p.Currency,
  }));
}

interface Attr {
  AttributeName?: string;
  AttributeValue?: string;
  [key: string]: unknown;
}

function attrsToDict(attrs: Attr[] | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of attrs ?? []) {
    const name = a.AttributeName;
    const value = a.AttributeValue;
    if (name && value) out[name.trim()] = value;
  }
  return out;
}

interface MouserPart {
  ManufacturerPartNumber?: string;
  MouserPartNumber?: string;
  Manufacturer?: string;
  Category?: string;
  MouserProductCategory?: string;
  Description?: string;
  Availability?: string;
  AvailabilityInStock?: string;
  AvailabilityOnOrder?: unknown[];
  LeadTime?: string;
  LifecycleStatus?: string;
  ROHSStatus?: string;
  DataSheetUrl?: string;
  ProductDetailUrl?: string;
  ImagePath?: string;
  PriceBreaks?: PriceBreak[];
  ProductAttributes?: Attr[];
  ProductCompliance?: Attr[];
  SuggestedReplacement?: string;
  RestrictionMessage?: string;
  SurchargeMessages?: unknown[];
  Min?: number;
  Mult?: number;
  [key: string]: unknown;
}

// Generic English stop words — filtered out before token scoring so they
// don't dilute relevance. No domain-specific lists needed.
const STOP_WORDS = new Set([
  "a","an","the","and","or","of","in","on","at","to","for","with","by",
  "from","up","is","it","its","be","as","so","we","he","she","they","do",
  "did","but","not","if","can","will","are","was","were","has","had","have",
  "this","that","these","those","then","than","into","over","also","per",
]);

/**
 * Returns a weight for a query token based purely on its length.
 * Longer tokens are statistically rarer and more specific — no hardcoded
 * term lists required.
 *
 * len 2–3  → weight 1   (e.g. "op", "dc")
 * len 4–5  → weight 1.5 (e.g. "uart", "mosfet" short forms)
 * len 6–8  → weight 2   (e.g. "sensor", "voltage")
 * len 9+   → weight 3   (e.g. "bluetooth", "microcontroller")
 */
function tokenWeight(token: string): number {
  const len = token.length;
  if (len >= 9) return 3;
  if (len >= 6) return 2;
  if (len >= 4) return 1.5;
  return 1;
}

function scorePart(part: MouserPart, query: string): number {
  const queryNorm   = query.toLowerCase().trim();
  const queryNoSpace = queryNorm.replace(/\s/g, "");

  // Tokenise: keep alphanumeric plus characters common in electronics notation
  // (dots, slashes, hyphens, plus signs) so things like "3.3v", "rs-485",
  // "c++" still match as single tokens.
  const queryTokens = queryNorm
    .split(/\s+/)
    .map((w) => w.replace(/[^a-z0-9.+/\-]/g, ""))
    .filter((w) => w.length >= 2 && !STOP_WORDS.has(w));

  const mfrPn        = (part.ManufacturerPartNumber ?? "").toLowerCase();
  const mouserPn     = (part.MouserPartNumber ?? "").toLowerCase();
  const description  = (part.Description ?? "").toLowerCase();
  const category     = (part.Category ?? part.MouserProductCategory ?? "").toLowerCase();
  const manufacturer = (part.Manufacturer ?? "").toLowerCase();
  const availability = String(part.AvailabilityInStock ?? part.Availability ?? "");
  const lifecycle    = (part.LifecycleStatus ?? "").toLowerCase();
  const attrsText    = Object.values(attrsToDict(part.ProductAttributes)).join(" ").toLowerCase();

  let score = 0;

  // 1. Exact full-query match — strongest signal
  if (mfrPn.replace(/\s/g, "") === queryNoSpace)    score += 200;
  else if (mouserPn.replace(/\s/g, "") === queryNoSpace) score += 190;

  // 2. Full phrase match as substring
  if (mfrPn.includes(queryNorm))          score += 80;
  else if (mouserPn.includes(queryNorm))  score += 75;
  if (description.includes(queryNorm))    score += 30;
  if (category.includes(queryNorm))       score += 20;

  // 3. Per-token scoring, weighted by token length (specificity proxy).
  //    Field weights reflect how diagnostic each field is.
  //    No hardcoded term lists — any token the user types is handled.
  for (const token of queryTokens) {
    const w = tokenWeight(token);
    if (mfrPn.includes(token))        score += Math.round(15 * w);
    if (mouserPn.includes(token))     score += Math.round(12 * w);
    if (description.includes(token))  score += Math.round(8  * w);
    if (category.includes(token))     score += Math.round(6  * w);
    if (manufacturer.includes(token)) score += Math.round(4  * w);
    if (attrsText.includes(token))    score += Math.round(3  * w);
  }

  // 4. Penalise bad lifecycle / availability status
  const badStatuses = [
    "not accepting orders",
    "obsolete",
    "discontinued",
    "not recommended",
    "verify status with factory",
    "end of life",
  ];
  for (const bad of badStatuses) {
    if (lifecycle.includes(bad) || availability.toLowerCase().includes(bad)) {
      score -= 50;
      break;
    }
  }

  // 5. Stock bonus — modest; relevance always outranks stock alone
  try {
    const stock = parseInt(availability.replace(/\D/g, "") || "0", 10);
    if (stock > 0)    score += 10;
    if (stock > 100)  score += 5;
    if (stock > 1000) score += 5;
  } catch { /* ignore */ }

  // 6. Small resource bonuses
  if (part.DataSheetUrl)     score += 5;
  if (part.ProductDetailUrl) score += 3;

  return score;
}

function simplifyPart(part: MouserPart, query?: string) {
  const attrs = attrsToDict(part.ProductAttributes);
  const compliance = attrsToDict(part.ProductCompliance);

  const simplified: Record<string, unknown> = {
    manufacturer: part.Manufacturer,
    manufacturer_part_number: part.ManufacturerPartNumber,
    mouser_part_number: part.MouserPartNumber,
    category: part.Category ?? part.MouserProductCategory,
    description: part.Description,
    availability: part.Availability,
    availability_in_stock: part.AvailabilityInStock,
    on_order: part.AvailabilityOnOrder ?? [],
    lead_time: part.LeadTime,
    lifecycle_status: part.LifecycleStatus,
    rohs_status: part.ROHSStatus,
    datasheet_url: part.DataSheetUrl,
    product_url: part.ProductDetailUrl,
    image_url: part.ImagePath,
    price_breaks: cleanMoney(part.PriceBreaks),
    attributes: attrs,
    compliance: compliance,
    suggested_replacement: part.SuggestedReplacement,
    restriction_message: part.RestrictionMessage,
    surcharge_messages: part.SurchargeMessages ?? [],
    min_order_qty: part.Min,
    multiple_order_qty: part.Mult,
  };

  if (query !== undefined) {
    simplified.ranking_score = scorePart(part, query);
  }

  return simplified;
}

const ANSWER_ALIASES: Record<string, string[]> = {
  "operating voltage": [
    "Operating Supply Voltage",
    "Supply Voltage - Min",
    "Supply Voltage - Max",
    "Voltage Rating",
    "Voltage - Supply",
    "Voltage Supply",
  ],
  "supply voltage": [
    "Operating Supply Voltage",
    "Supply Voltage - Min",
    "Supply Voltage - Max",
    "Voltage - Supply",
    "Voltage Supply",
  ],
  interface: ["Interface Type", "Interface"],
  "sensor type": ["Type", "Sensor Type", "Product"],
  package: ["Package / Case", "Package", "Mounting Style"],
  current: ["Current Rating", "Supply Current", "Operating Supply Current"],
  temperature: [
    "Operating Temperature",
    "Minimum Operating Temperature",
    "Maximum Operating Temperature",
  ],
  rohs: ["ROHSStatus"],
  stock: ["AvailabilityInStock"],
  price: ["PriceBreaks"],
  datasheet: ["DataSheetUrl"],
};

function extractAnswerValue(part: MouserPart, question: string) {
  const q = question.toLowerCase();
  const attrs = attrsToDict(part.ProductAttributes);

  for (const [intent, keys] of Object.entries(ANSWER_ALIASES)) {
    if (q.includes(intent)) {
      if (intent === "rohs") return { field: "RoHS", value: part.ROHSStatus };
      if (intent === "stock") return { field: "Stock", value: part.AvailabilityInStock ?? part.Availability };
      if (intent === "price") {
        const prices = cleanMoney(part.PriceBreaks);
        return { field: "Price", value: prices[0] ?? null };
      }
      if (intent === "datasheet") return { field: "Datasheet", value: part.DataSheetUrl };
      for (const k of keys) {
        if (k in attrs) return { field: k, value: attrs[k] };
      }
    }
  }

  return { field: null, value: null };
}

function getPartsFromResult(result: unknown): MouserPart[] {
  if (!result || typeof result !== "object") return [];
  const r = result as Record<string, unknown>;
  if (r.Errors && Array.isArray(r.Errors) && r.Errors.length > 0) return [];
  const sr = r.SearchResults as Record<string, unknown> | undefined;
  if (!sr) return [];
  return (sr.Parts as MouserPart[]) ?? [];
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

router.get("/", (_req, res) => {
  res.json({
    status: "ok",
    message: "Electronics part lookup wrapper is running.",
    endpoints: [
      "POST /api/lookup-part",
      "POST /api/search-keyword",
      "POST /api/compare-parts",
    ],
  });
});

router.post("/lookup-part", async (req: Request, res: Response) => {
  const data = req.body ?? {};
  const partNumber: string =
    data.part_number ?? data.partNumber ?? data.mouserPartNumber ?? data.query ?? data.part ?? "";
  const question: string = data.question ?? "";

  if (!partNumber) {
    res.status(400).json({ error: "Missing part_number" });
    return;
  }

  const { data: result, status } = await mouserPost(req, "/search/partnumber", {
    SearchByPartRequest: {
      mouserPartNumber: partNumber,
      partSearchOptions: "None",
      mouserPaysCustomsAndDuties: false,
    },
  });

  const parts = getPartsFromResult(result);
  const ranked = [...parts].sort((a, b) => scorePart(b, partNumber) - scorePart(a, partNumber));
  const topParts = ranked.slice(0, 5).map((p) => simplifyPart(p, partNumber));

  const specificAnswer = question && ranked.length > 0 ? extractAnswerValue(ranked[0]!, question) : null;

  res.status(status).json({
    query: partNumber,
    mode: "part_number_lookup",
    result_count: parts.length,
    best_match: topParts[0] ?? null,
    top_parts: topParts,
    specific_answer: specificAnswer,
    errors: typeof result === "object" && result !== null ? (result as Record<string, unknown>).Errors : null,
  });
});

router.post("/search-keyword", async (req: Request, res: Response) => {
  const data = req.body ?? {};
  const keyword: string = data.keyword ?? data.query ?? data.part_number ?? "";

  if (!keyword) {
    res.status(400).json({ error: "Missing keyword" });
    return;
  }

  const records = Math.max(1, Math.min(Number(data.records ?? 10), 50));

  const { data: result, status } = await mouserPost(req, "/search/keyword", {
    SearchByKeywordRequest: {
      keyword,
      records,
      startingRecord: 0,
      searchOptions: "None",
      searchWithYourSignUpLanguage: true,
      mouserPaysCustomsAndDuties: false,
    },
  });

  const parts = getPartsFromResult(result);
  const ranked = [...parts].sort((a, b) => scorePart(b, keyword) - scorePart(a, keyword));

  res.status(status).json({
    query: keyword,
    mode: "keyword_search",
    result_count: parts.length,
    best_match: ranked[0] ? simplifyPart(ranked[0], keyword) : null,
    top_parts: ranked.slice(0, 5).map((p) => simplifyPart(p, keyword)),
    errors: typeof result === "object" && result !== null ? (result as Record<string, unknown>).Errors : null,
  });
});

router.post("/compare-parts", async (req: Request, res: Response) => {
  const data = req.body ?? {};
  let partsIn: string[] | string = data.parts ?? data.part_numbers ?? [];

  if (typeof partsIn === "string") {
    partsIn = partsIn
      .split(/[,\n]+/)
      .map((p: string) => p.trim())
      .filter(Boolean);
  }

  if (!partsIn.length) {
    res.status(400).json({ error: "Missing parts list" });
    return;
  }

  const comparisons = await Promise.all(
    partsIn.slice(0, 5).map(async (partNumber) => {
      const { data: result } = await mouserPost(req, "/search/partnumber", {
        SearchByPartRequest: {
          mouserPartNumber: partNumber,
          partSearchOptions: "None",
          mouserPaysCustomsAndDuties: false,
        },
      });

      const parts = getPartsFromResult(result);
      const ranked = [...parts].sort((a, b) => scorePart(b, partNumber) - scorePart(a, partNumber));

      return {
        query: partNumber,
        best_match: ranked[0] ? simplifyPart(ranked[0], partNumber) : null,
        result_count: parts.length,
      };
    }),
  );

  res.json({ mode: "compare_parts", comparisons });
});

// ---------------------------------------------------------------------------
// Playwright browser singleton
// ---------------------------------------------------------------------------

/**
 * Resolve the path to the system Chromium executable.
 * Prefers PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH env var, then `which chromium`.
 * Returns null if not found — Playwright will fall back to its downloaded binary.
 */
function resolveChromiumPath(): string | undefined {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
    return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  }
  try {
    return execSync("which chromium", { encoding: "utf8", timeout: 3000 }).trim() || undefined;
  } catch {
    try {
      return execSync("which chromium-browser", { encoding: "utf8", timeout: 3000 }).trim() || undefined;
    } catch {
      return undefined;
    }
  }
}

let _browserPromise: Promise<import("playwright").Browser> | null = null;
let _idleTimer: NodeJS.Timeout | null = null;
const BROWSER_IDLE_MS = 5 * 60 * 1000; // auto-close after 5 min of inactivity

/**
 * Return a shared Playwright browser, creating it on first call.
 * The browser is automatically closed after 5 minutes of inactivity to
 * avoid leaving zombie Chromium processes in production.
 */
async function getBrowser(): Promise<import("playwright").Browser> {
  // Lazily import playwright so the module still loads even if playwright
  // is not installed yet (build.mjs externalises it).
  const { chromium } = await import("playwright");

  if (!_browserPromise) {
    const executablePath = resolveChromiumPath();
    _browserPromise = chromium.launch({
      executablePath,
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--single-process",
      ],
    }).then((b) => {
      b.on("disconnected", () => { _browserPromise = null; });
      return b;
    }).catch((err) => {
      _browserPromise = null;
      throw err;
    });
  }

  // Reset idle timer every time the browser is requested
  if (_idleTimer) clearTimeout(_idleTimer);
  _idleTimer = setTimeout(async () => {
    const br = await _browserPromise?.catch(() => null);
    _browserPromise = null;
    _idleTimer = null;
    await br?.close().catch(() => null);
  }, BROWSER_IDLE_MS);

  return _browserPromise;
}

/**
 * Generic spec-row extraction function run inside the page context.
 * Tries multiple structural patterns so it works across Mouser page layouts
 * (React SPA, legacy table layout, definition lists, card-based grids).
 *
 * Returns { specs: Record<string, string>, strategy: string }.
 * Exported as a string so it can be serialised into page.evaluate().
 */
const PAGE_EXTRACT_FN = `
() => {
  const clean = (s) =>
    (s || "")
      .replace(/\\s+/g, " ")
      .replace(/[\\u00a0]/g, " ")
      .trim();

  const add = (out, key, val) => {
    const k = clean(key);
    const v = clean(val);
    if (k && v && k.length < 150 && v.length < 800 && !out[k]) out[k] = v;
  };

  let out = {};

  // ── Strategy A: standard two-cell <tr> rows ─────────────────────────────
  // Works for any table that uses <th> or first-<td> as label
  for (const tr of document.querySelectorAll("table tr")) {
    const cells = tr.querySelectorAll("td,th");
    if (cells.length >= 2) add(out, cells[0].innerText, cells[1].innerText);
  }

  // ── Strategy B: definition lists <dl><dt>key</dt><dd>val</dd></dl> ───────
  const dts = document.querySelectorAll("dt");
  for (const dt of dts) {
    const dd = dt.nextElementSibling;
    if (dd && dd.tagName === "DD") add(out, dt.innerText, dd.innerText);
  }

  // ── Strategy C: elements with "spec" in class (Mouser SPA patterns) ─────
  const specRows = document.querySelectorAll(
    '[class*="spec-row"],[class*="specRow"],[class*="SpecRow"],' +
    '[class*="attribute-row"],[class*="attributeRow"],' +
    '[class*="product-attribute"],[class*="productAttribute"]'
  );
  for (const row of specRows) {
    const label = row.querySelector(
      '[class*="label"],[class*="Label"],[class*="name"],[class*="Name"],' +
      '[class*="key"],[class*="Key"],[class*="attr-name"],[class*="attrName"]'
    );
    const value = row.querySelector(
      '[class*="value"],[class*="Value"],[class*="data"],[class*="Data"],' +
      '[class*="attr-value"],[class*="attrValue"]'
    );
    if (label && value) add(out, label.innerText, value.innerText);
  }

  // ── Strategy D: Mouser React SPA — MUI-based table cells (2024 layout) ──
  const muiRows = document.querySelectorAll(
    '.MuiTableRow-root,.MuiGrid-root[class*="row"]'
  );
  for (const row of muiRows) {
    const cells = row.querySelectorAll(".MuiTableCell-root,.MuiGrid-item");
    if (cells.length >= 2) add(out, cells[0].innerText, cells[1].innerText);
  }

  // ── Strategy E: generic key/value pair divs by data attributes ───────────
  for (const el of document.querySelectorAll("[data-label]")) {
    add(out, el.getAttribute("data-label"), el.innerText);
  }
  for (const el of document.querySelectorAll("[data-spec-label]")) {
    const sib = el.nextElementSibling;
    if (sib) add(out, el.innerText, sib.innerText);
  }

  // Remove noise rows whose key is just whitespace / punctuation
  const filtered = {};
  for (const [k, v] of Object.entries(out)) {
    if (k.replace(/[^a-zA-Z0-9]/g, "").length >= 2) filtered[k] = v;
  }

  const count = Object.keys(filtered).length;
  const strategy =
    count > 20 ? "rich-table" :
    count > 5  ? "partial-table" :
    count > 0  ? "minimal" : "none";

  return { specs: filtered, strategy };
}
`;

interface ScrapeResult {
  specs: Record<string, string>;
  strategy: string;
  scrape_status: "ok" | "failed_fallback_used";
  error?: string;
}

/**
 * Scrape the Mouser product page at `url` using headless Chromium.
 * Returns all visible spec rows as a flat key→value dictionary.
 * On any failure, returns an empty dict with scrape_status "failed_fallback_used".
 */
async function scrapeMouserProductPage(
  url: string,
  log: { warn: (obj: object, msg: string) => void },
): Promise<ScrapeResult> {
  let browser: import("playwright").Browser | null = null;
  let page: import("playwright").Page | null = null;

  try {
    browser = await getBrowser();
    page = await browser.newPage();

    // Block images, fonts, media — we only need the DOM
    await page.route("**/*", (route) => {
      const rt = route.request().resourceType();
      if (["image", "font", "media", "stylesheet"].includes(rt)) {
        route.abort().catch(() => null);
      } else {
        route.continue().catch(() => null);
      }
    });

    await page.setExtraHTTPHeaders({
      "Accept-Language": "en-US,en;q=0.9",
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
    });

    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 15_000,
    });

    if (!response?.ok()) {
      throw new Error(`HTTP ${response?.status() ?? "unknown"} from Mouser product page`);
    }

    // Wait for React to hydrate the spec table (up to 10 s)
    await page
      .waitForSelector(
        'table tr, dt, [class*="spec"], [class*="Spec"], [class*="attribute"], [class*="Attribute"], .MuiTableRow-root',
        { timeout: 10_000 },
      )
      .catch(() => null); // non-fatal — try extraction anyway

    const { specs, strategy } = await page.evaluate(
      new Function(`return (${PAGE_EXTRACT_FN})()`) as () => {
        specs: Record<string, string>;
        strategy: string;
      },
    );

    return { specs, strategy, scrape_status: "ok" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ err: { message: msg } }, "Playwright scrape failed, using API fallback");
    return { specs: {}, strategy: "none", scrape_status: "failed_fallback_used", error: msg };
  } finally {
    await page?.close().catch(() => null);
  }
}

// ---------------------------------------------------------------------------
// Product specs helpers
// ---------------------------------------------------------------------------

/**
 * Tokenise text for spec question matching.
 * Reuses the module-level STOP_WORDS set.
 */
function tokenizeText(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s\-_/,()[\]]+/)
    .map((w) => w.replace(/[^a-z0-9.+]/g, ""))
    .filter((w) => w.length >= 2 && !STOP_WORDS.has(w));
}

/**
 * Build a complete flat spec dictionary from a MouserPart object.
 *
 * Includes every ProductAttribute row (these are the same rows shown on the
 * Mouser product page spec table) plus key top-level fields such as
 * manufacturer, description, lifecycle, RoHS, stock, lead time, and pricing.
 *
 * Fully generic — no hardcoded field names or part categories.
 */
function buildSpecDict(part: MouserPart): Record<string, string> {
  const specs: Record<string, string> = {};

  const set = (key: string, value: unknown) => {
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      specs[key] = String(value).trim();
    }
  };

  // Top-level product identity fields
  set("Manufacturer", part.Manufacturer);
  set("Manufacturer Part Number", part.ManufacturerPartNumber);
  set("Mouser Part Number", part.MouserPartNumber);
  set("Category", part.Category ?? part.MouserProductCategory);
  set("Description", part.Description);
  set("Lifecycle Status", part.LifecycleStatus);
  set("RoHS Status", part.ROHSStatus);
  set("Availability", part.AvailabilityInStock ?? part.Availability);
  set("Lead Time", part.LeadTime);
  set("Minimum Order Qty", part.Min);
  set("Multiple Order Qty", part.Mult);
  if (part.SuggestedReplacement) set("Suggested Replacement", part.SuggestedReplacement);

  // Pricing — flatten price breaks into readable strings
  const prices = cleanMoney(part.PriceBreaks);
  prices.forEach((p, i) => {
    if (p.price && p.quantity) {
      set(`Price (qty ${p.quantity})`, `${p.price} ${p.currency ?? ""}`.trim());
    } else if (i === 0 && p.price) {
      set("Price", `${p.price} ${p.currency ?? ""}`.trim());
    }
  });

  // All product attribute rows (the actual spec table on the product page)
  for (const attr of part.ProductAttributes ?? []) {
    const name = attr.AttributeName?.trim();
    const val  = attr.AttributeValue?.trim();
    if (name && val) specs[name] = val;
  }

  // Compliance attributes (RoHS details, REACH, etc.)
  for (const attr of part.ProductCompliance ?? []) {
    const name = attr.AttributeName?.trim();
    const val  = attr.AttributeValue?.trim();
    if (name && val && !specs[name]) specs[name] = val;
  }

  return specs;
}

/**
 * Given a natural-language question and a spec dictionary, return the best
 * matching field/value using a two-tier scoring model:
 *
 *   Tier 1 — key overlap   (weight ×2): question tokens match spec key tokens.
 *             This fires when the API returns a named attribute (e.g.
 *             "Operating Voltage", "Number of Contacts").
 *
 *   Tier 2 — value overlap (weight ×1): question tokens match tokens inside
 *             the spec value.  This fires when the answer is embedded in the
 *             description text (e.g. "6 Pin Connector", "Wi-Fi 6 Bluetooth 5").
 *             Sub-string matching ("pins" ↔ "pin") is handled by checking both
 *             directions: qt.includes(vt) || vt.includes(qt).
 *
 * Confidence is derived from the combined score so callers know how reliable
 * the answer is.  Fully generic — no hardcoded field name mappings.
 */
function matchSpecQuestion(
  question: string,
  specs: Record<string, string>,
): { field: string; value: string; confidence: "high" | "medium" | "low" } | null {
  // Strip interrogative / auxiliary words that carry no spec-matching signal
  const QUESTION_STOP = new Set([
    ...Array.from(STOP_WORDS),
    "what", "which", "where", "when", "how", "why", "does", "do", "did",
    "is", "are", "was", "were", "will", "would", "could", "should", "get",
    "tell", "me", "give", "show", "find", "many", "much",
  ]);

  const qTokens = question
    .toLowerCase()
    .split(/[\s\-_/,()[\]]+/)
    .map((w) => w.replace(/[^a-z0-9.+]/g, ""))
    .filter((w) => w.length >= 2 && !QUESTION_STOP.has(w));

  if (!qTokens.length) return null;

  let bestKey = "";
  let bestScore = 0;

  for (const [key, val] of Object.entries(specs)) {
    const keyTokens = tokenizeText(key);
    const valTokens = tokenizeText(val);
    const valLower  = val.toLowerCase();

    let score = 0;

    // Tier 1: key token overlap (×2 weight — named attribute match)
    for (const qt of qTokens) {
      for (const kt of keyTokens) {
        if (kt.includes(qt) || qt.includes(kt)) score += 2;
      }
    }

    // Tier 2: value token overlap (×1 weight — answer embedded in value text)
    for (const qt of qTokens) {
      for (const vt of valTokens) {
        if (vt.includes(qt) || qt.includes(vt)) score += 1;
      }
      // Also raw substring match — catches "6" in "6 Pin" for question "6 pins"
      if (valLower.includes(qt)) score += 0.5;
    }

    if (score > bestScore) {
      bestScore = score;
      bestKey   = key;
    }
  }

  if (!bestKey || bestScore === 0) return null;

  const confidence: "high" | "medium" | "low" =
    bestScore >= 4 ? "high" : bestScore >= 2 ? "medium" : "low";

  return { field: bestKey, value: specs[bestKey]!, confidence };
}

// ---------------------------------------------------------------------------
// POST /product-page-specs
// ---------------------------------------------------------------------------

router.post("/product-page-specs", async (req: Request, res: Response) => {
  const data = req.body ?? {};
  const partNumber: string =
    data.part_number ?? data.partNumber ?? data.mouserPartNumber ?? "";
  // Caller may pass a product_url directly to skip the API lookup step
  let productUrl: string = data.product_url ?? data.productUrl ?? "";
  const question: string = data.question ?? "";

  // ── Step 1: resolve the best-match part via Mouser API ──────────────────
  // Always run API lookup so we have the fallback spec dict ready.
  // Skip only if both product_url AND we don't care about the fallback dict.
  let best: MouserPart | null = null;

  {
    // Always run the API lookup — needed for the fallback spec dict even when
    // product_url is provided by the caller.
    if (partNumber) {
      const { data: result, status } = await mouserPost(req, "/search/partnumber", {
        SearchByPartRequest: {
          mouserPartNumber: partNumber,
          partSearchOptions: "None",
          mouserPaysCustomsAndDuties: false,
        },
      });

      const parts = getPartsFromResult(result);
      if (parts.length) {
        const ranked = [...parts].sort(
          (a, b) => scorePart(b, partNumber) - scorePart(a, partNumber),
        );
        best = ranked[0]!;
        if (!productUrl && best.ProductDetailUrl) {
          productUrl = best.ProductDetailUrl;
        }
      } else {
        if (!productUrl) {
          res.status(status === 200 ? 404 : status).json({
            error: `No Mouser results for "${partNumber}"`,
            part_number: partNumber,
            errors:
              typeof result === "object" && result !== null
                ? (result as Record<string, unknown>).Errors
                : null,
          });
          return;
        }
      }
    } else if (!productUrl) {
      res.status(400).json({ error: "Provide part_number or product_url" });
      return;
    }
  }

  // ── Step 2: build API-based fallback spec dict ───────────────────────────
  const apiSpecs = best ? buildSpecDict(best) : {};

  // ── Step 3: attempt Playwright scrape of the product page ────────────────
  let scrapeResult: ScrapeResult = {
    specs: {},
    strategy: "none",
    scrape_status: "failed_fallback_used",
    error: productUrl ? undefined : "No product URL available",
  };

  if (productUrl) {
    scrapeResult = await scrapeMouserProductPage(productUrl, {
      warn: (obj, msg) => req.log.warn(obj, msg),
    });
  }

  // ── Step 4: merge specs — scraped data preferred; API fills gaps ─────────
  // If scraping succeeded and returned more than the API fallback, use it as
  // the primary source. If it returned nothing useful, fall back entirely to
  // the API-derived dict. Either way, API fields fill any missing keys.
  let specifications: Record<string, string>;
  let specsSource: "mouser_product_page" | "mouser_api";

  if (scrapeResult.scrape_status === "ok" && Object.keys(scrapeResult.specs).length > 0) {
    // Merge: scraped wins on conflict, API fills gaps
    specifications = { ...apiSpecs, ...scrapeResult.specs };
    specsSource = "mouser_product_page";
  } else {
    specifications = apiSpecs;
    specsSource = "mouser_api";
  }

  // ── Step 5: generic question matching ────────────────────────────────────
  const matchedAnswer =
    question && Object.keys(specifications).length > 0
      ? matchSpecQuestion(question, specifications)
      : null;

  const specificAnswer = matchedAnswer
    ? { ...matchedAnswer, source: specsSource }
    : null;

  res.json({
    part_number: best?.ManufacturerPartNumber ?? partNumber ?? null,
    mouser_part_number: best?.MouserPartNumber ?? null,
    product_url: productUrl || null,
    scrape_status: scrapeResult.scrape_status,
    scrape_strategy: scrapeResult.strategy,
    scrape_error: scrapeResult.error ?? null,
    specs_source: specsSource,
    spec_count: Object.keys(specifications).length,
    specific_answer: specificAnswer,
    specifications,
  });
});

export default router;
