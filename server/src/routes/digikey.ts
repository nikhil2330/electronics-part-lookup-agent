import { Router, type IRouter, type Request, type Response } from "express";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function getConfig() {
  const clientId     = process.env.DIGIKEY_CLIENT_ID     ?? "";
  const clientSecret = process.env.DIGIKEY_CLIENT_SECRET ?? "";
  const env          = (process.env.DIGIKEY_ENV ?? "sandbox").toLowerCase();
  const isSandbox    = env === "sandbox";
  const apiBase      = isSandbox
    ? "https://sandbox-api.digikey.com"
    : "https://api.digikey.com";
  return { clientId, clientSecret, apiBase, isSandbox };
}

const TOKEN_ENDPOINT_PRODUCTION = "https://api.digikey.com/v1/oauth2/token";
const TOKEN_ENDPOINT_SANDBOX    = "https://sandbox-api.digikey.com/v1/oauth2/token";

// ---------------------------------------------------------------------------
// OAuth token cache
// ---------------------------------------------------------------------------

interface TokenCache {
  accessToken: string;
  expiresAt:   number; // ms since epoch
}

let _tokenCache: TokenCache | null = null;

/**
 * Fetch a new OAuth2 client_credentials token from DigiKey and cache it.
 * Returns the cached token if still valid (with a 60 s safety margin).
 */
async function getAccessToken(log: { error: (obj: object, msg: string) => void }): Promise<string> {
  const now = Date.now();
  if (_tokenCache && _tokenCache.expiresAt - now > 60_000) {
    return _tokenCache.accessToken;
  }

  const { clientId, clientSecret, isSandbox } = getConfig();
  if (!clientId || !clientSecret) {
    throw new Error("Missing DIGIKEY_CLIENT_ID or DIGIKEY_CLIENT_SECRET");
  }

  const tokenEndpoint = isSandbox ? TOKEN_ENDPOINT_SANDBOX : TOKEN_ENDPOINT_PRODUCTION;

  const body = new URLSearchParams({
    grant_type:    "client_credentials",
    client_id:     clientId,
    client_secret: clientSecret,
  });

  const res = await fetch(tokenEndpoint, {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:    body.toString(),
    signal:  AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`DigiKey token request failed (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }

  const json = (await res.json()) as {
    access_token: string;
    expires_in:   number;
    token_type:   string;
  };

  _tokenCache = {
    accessToken: json.access_token,
    expiresAt:   now + json.expires_in * 1000,
  };

  log.error({}, `DigiKey token obtained, expires in ${json.expires_in}s`);
  return _tokenCache.accessToken;
}

// ---------------------------------------------------------------------------
// DigiKey V4 types (subset)
// ---------------------------------------------------------------------------

interface DKDescription {
  ProductDescription?: string;
  DetailedDescription?: string;
}

interface DKManufacturer {
  Id?:   number;
  Name?: string;
}

interface DKCategory {
  Id?:   number;
  Name?: string;
}

interface DKPriceBreak {
  BreakQuantity?: number;
  UnitPrice?:     number;
  TotalPrice?:    number;
}

interface DKVariation {
  DigiKeyProductNumber?: string;
  QuantityAvailable?:    number;
  StandardPricing?:      DKPriceBreak[];
  PackagingOption?:      { Id?: number; Name?: string };
}

interface DKParameter {
  ParameterId?:   number;
  ParameterText?: string;
  ValueId?:       string;
  ValueText?:     string;
}

interface DKProductStatus {
  Id?:     number;
  Status?: string;
}

interface DKProduct {
  ManufacturerProductNumber?: string;
  Description?:               DKDescription;
  Manufacturer?:              DKManufacturer;
  Category?:                  DKCategory;
  ProductVariations?:         DKVariation[];
  ProductUrl?:                string;
  DatasheetUrl?:              string;
  Parameters?:                DKParameter[];
  ProductStatus?:             DKProductStatus;
  QuantityAvailable?:         number;
  [key: string]: unknown;
}

interface DKSearchResponse {
  Products?:      DKProduct[];
  ProductsCount?: number;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Shared DigiKey request headers
// ---------------------------------------------------------------------------

function digiKeyHeaders(token: string, clientId: string): Record<string, string> {
  return {
    "Content-Type":              "application/json",
    Accept:                      "application/json",
    Authorization:               `Bearer ${token}`,
    "X-DIGIKEY-Client-Id":       clientId,
    "X-DIGIKEY-Locale-Site":     "US",
    "X-DIGIKEY-Locale-Language": "en",
    "X-DIGIKEY-Locale-Currency": "USD",
    "X-DIGIKEY-Customer-Id":     "0",
  };
}

// ---------------------------------------------------------------------------
// Generic question → parameter matching
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  "what","is","the","a","an","of","for","this","part","does","how","many",
  "which","are","can","its","value","tell","me","give","show","find","get",
  "any","some","all","do","with","in","on","at","by","to","from","has","have",
]);

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

function findSpecificAnswer(
  question: string,
  parameters: Record<string, string>,
): { field: string; value: string; confidence: "high" | "medium" | "low"; source: string } | null {
  const qTokens = tokenize(question);
  if (qTokens.length === 0 || Object.keys(parameters).length === 0) return null;

  const qSet    = new Set(qTokens);
  const qPhrase = question.toLowerCase();

  let best: { field: string; value: string; score: number } | null = null;

  for (const [field, value] of Object.entries(parameters)) {
    const fieldLower  = field.toLowerCase();
    const fieldTokens = new Set(tokenize(field));
    const valueTokens = new Set(tokenize(value));
    const allTokens   = new Set([...fieldTokens, ...valueTokens]);

    // Base: token overlap
    let score = 0;
    for (const t of qSet) if (allTokens.has(t)) score++;

    // Bonus: question contains entire field name substring
    if (qPhrase.includes(fieldLower)) score += 4;

    // Bonus: each question token appears in field name
    for (const qt of qSet) if (fieldLower.includes(qt)) score += 1.5;

    // Bonus: exact field token match (high-signal)
    for (const ft of fieldTokens) if (qSet.has(ft)) score += 1;

    if (score > 0 && (!best || score > best.score)) {
      best = { field, value, score };
    }
  }

  if (!best) return null;

  // Normalise: max imaginable score is qTokens.length * 3.5 + 4
  const maxScore   = qTokens.length * 3.5 + 4;
  const ratio      = best.score / maxScore;
  const confidence = ratio >= 0.55 ? "high" : ratio >= 0.2 ? "medium" : "low";

  return {
    field:  best.field,
    value:  best.value,
    confidence,
    source: "digikey_product_details",
  };
}

// ---------------------------------------------------------------------------
// DigiKey V4 ProductDetails type
// ---------------------------------------------------------------------------

interface DKProductDetailsResponse {
  Product?: DKProduct;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Part normaliser
// ---------------------------------------------------------------------------

/**
 * Flatten a raw DigiKey V4 product object into the API's clean shape.
 * Picks the first (lowest-MOQ) ProductVariation for stock and pricing.
 * Parameters are returned as a generic flat dict — no hardcoded field names.
 */
function cleanPart(p: DKProduct) {
  const variation = p.ProductVariations?.[0];

  const priceBreaks = (variation?.StandardPricing ?? []).slice(0, 6).map((pb) => ({
    break_quantity: pb.BreakQuantity,
    unit_price:     pb.UnitPrice,
    total_price:    pb.TotalPrice,
  }));

  const parameters: Record<string, string> = {};
  for (const param of p.Parameters ?? []) {
    const key = param.ParameterText?.trim();
    const val = param.ValueText?.trim();
    if (key && val) parameters[key] = val;
  }

  return {
    manufacturer:              p.Manufacturer?.Name ?? null,
    manufacturer_part_number:  p.ManufacturerProductNumber ?? null,
    digikey_part_number:       variation?.DigiKeyProductNumber ?? null,
    category:                  p.Category?.Name ?? null,
    description:               p.Description?.DetailedDescription
                               ?? p.Description?.ProductDescription
                               ?? null,
    quantity_available:        p.QuantityAvailable ?? variation?.QuantityAvailable ?? 0,
    availability:              p.QuantityAvailable != null
                               ? String(p.QuantityAvailable)
                               : null,
    price_breaks:              priceBreaks,
    datasheet_url:             p.DatasheetUrl ?? null,
    product_url:               p.ProductUrl ?? null,
    product_status:            p.ProductStatus?.Status ?? null,
    packaging:                 variation?.PackagingOption?.Name ?? null,
    parameters,
  };
}

// ---------------------------------------------------------------------------
// POST /digikey-search
// ---------------------------------------------------------------------------

router.post("/digikey-search", async (req: Request, res: Response) => {
  const data    = req.body ?? {};
  const keyword = String(data.keyword ?? data.query ?? "").trim();
  const records = Math.max(1, Math.min(Number(data.records ?? 10), 50));

  if (!keyword) {
    res.status(400).json({ error: "Provide keyword" });
    return;
  }

  const { clientId, apiBase, isSandbox } = getConfig();
  if (!clientId) {
    res.status(500).json({ error: "Missing DIGIKEY_CLIENT_ID environment variable" });
    return;
  }

  // 1 — obtain access token
  let token: string;
  try {
    token = await getAccessToken({ error: (obj, msg) => req.log.info(obj, msg) });
  } catch (err) {
    req.log.error({ err }, "DigiKey token fetch failed");
    res.status(502).json({
      error:   "DigiKey OAuth token request failed",
      details: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  // 2 — call KeywordSearch V4
  const searchUrl = `${apiBase}/products/v4/search/keyword`;

  const requestBody = {
    Keywords:    keyword,
    Limit:       records,
    Offset:      0,
    FilterOptionsRequest: {},
    SortOptions: {},
  };

  let raw: DKSearchResponse;
  let httpStatus: number;

  try {
    const r = await fetch(searchUrl, {
      method:  "POST",
      headers: digiKeyHeaders(token, clientId),
      body:   JSON.stringify(requestBody),
      signal: AbortSignal.timeout(20_000),
    });

    httpStatus = r.status;
    raw = (await r.json()) as DKSearchResponse;

    if (!r.ok) {
      req.log.warn({ status: httpStatus, body: raw }, "DigiKey search returned non-OK status");
      const detail =
        (raw as Record<string, unknown>).detail ??
        (raw as Record<string, unknown>).ErrorMessage ??
        (raw as Record<string, unknown>).title ??
        null;
      res.status(httpStatus).json({
        error:         "DigiKey API returned an error",
        http_status:   httpStatus,
        detail,
        hint:          httpStatus === 403
          ? "The DigiKey app is not subscribed to this API. Go to developer.digikey.com → your app → Add Subscriptions → Product Information V4."
          : undefined,
        digikey_error: raw,
        sandbox:       isSandbox,
        query:         keyword,
      });
      return;
    }
  } catch (err) {
    req.log.error({ err }, "DigiKey keyword search request failed");
    res.status(502).json({
      error:   "DigiKey search request failed",
      details: err instanceof Error ? err.message : String(err),
      sandbox: isSandbox,
      query:   keyword,
    });
    return;
  }

  // 3 — normalise results
  const products  = raw.Products ?? [];
  const cleaned   = products.map(cleanPart);
  const bestMatch = cleaned[0] ?? null;

  res.json({
    query:        keyword,
    mode:         "digikey_search",
    sandbox:      isSandbox,
    result_count: raw.ProductsCount ?? products.length,
    best_match:   bestMatch,
    top_parts:    cleaned,
  });
});

// ---------------------------------------------------------------------------
// POST /digikey-lookup
// ---------------------------------------------------------------------------

router.post("/digikey-lookup", async (req: Request, res: Response) => {
  const data       = req.body ?? {};
  const partNumber = String(data.part_number ?? data.partNumber ?? "").trim();
  const question   = String(data.question ?? "").trim();

  if (!partNumber) {
    res.status(400).json({ error: "Provide part_number" });
    return;
  }

  const { clientId, apiBase, isSandbox } = getConfig();
  if (!clientId) {
    res.status(500).json({ error: "Missing DIGIKEY_CLIENT_ID environment variable" });
    return;
  }

  // 1 — obtain access token
  let token: string;
  try {
    token = await getAccessToken({ error: (obj, msg) => req.log.info(obj, msg) });
  } catch (err) {
    req.log.error({ err }, "DigiKey token fetch failed");
    res.status(502).json({
      error:   "DigiKey OAuth token request failed",
      details: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  // 2 — try ProductDetails by part number (works well for DigiKey part numbers;
  //      also succeeds for many MPNs). Fall back to keyword search if 404.
  let product: ReturnType<typeof cleanPart> | null = null;
  let strategy = "productdetails";

  try {
    const detailsUrl = `${apiBase}/products/v4/search/${encodeURIComponent(partNumber)}/productdetails`;
    const dr = await fetch(detailsUrl, {
      method:  "GET",
      headers: digiKeyHeaders(token, clientId),
      signal:  AbortSignal.timeout(20_000),
    });

    if (dr.ok) {
      const body = (await dr.json()) as DKProductDetailsResponse;
      if (body.Product) {
        product = cleanPart(body.Product);
      }
    } else if (dr.status !== 404 && dr.status !== 400) {
      // Unexpected error — surface it
      const raw = (await dr.json().catch(() => ({}))) as Record<string, unknown>;
      const detail = raw.detail ?? raw.ErrorMessage ?? raw.title ?? null;
      req.log.warn({ status: dr.status, body: raw }, "DigiKey productdetails returned non-OK status");
      res.status(dr.status).json({
        error:         "DigiKey API returned an error",
        http_status:   dr.status,
        detail,
        hint:          dr.status === 403
          ? "The DigiKey app is not subscribed to this API. Go to developer.digikey.com → your app → Add Subscriptions → Product Information V4."
          : undefined,
        digikey_error: raw,
        sandbox:       isSandbox,
        query:         partNumber,
      });
      return;
    }
  } catch (err) {
    req.log.warn({ err }, "DigiKey productdetails fetch failed; falling back to keyword search");
  }

  // 3 — fallback: keyword search, pick the first result
  if (!product) {
    strategy = "keyword_fallback";
    try {
      const searchUrl = `${apiBase}/products/v4/search/keyword`;
      const sr = await fetch(searchUrl, {
        method:  "POST",
        headers: digiKeyHeaders(token, clientId),
        body:    JSON.stringify({ Keywords: partNumber, Limit: 5, Offset: 0 }),
        signal:  AbortSignal.timeout(20_000),
      });

      if (sr.ok) {
        const body = (await sr.json()) as DKSearchResponse;
        const first = (body.Products ?? [])[0];
        if (first) product = cleanPart(first);
      } else {
        const raw = (await sr.json().catch(() => ({}))) as Record<string, unknown>;
        const detail = raw.detail ?? raw.ErrorMessage ?? raw.title ?? null;
        req.log.warn({ status: sr.status, body: raw }, "DigiKey keyword fallback returned non-OK status");
        res.status(sr.status).json({
          error:         "DigiKey API returned an error",
          http_status:   sr.status,
          detail,
          hint:          sr.status === 403
            ? "The DigiKey app is not subscribed to this API. Go to developer.digikey.com → your app → Add Subscriptions → Product Information V4."
            : undefined,
          digikey_error: raw,
          sandbox:       isSandbox,
          query:         partNumber,
        });
        return;
      }
    } catch (err) {
      req.log.error({ err }, "DigiKey keyword fallback failed");
      res.status(502).json({
        error:   "DigiKey lookup failed",
        details: err instanceof Error ? err.message : String(err),
        sandbox: isSandbox,
        query:   partNumber,
      });
      return;
    }
  }

  // 4 — optional question matching
  const specificAnswer = question && product
    ? findSpecificAnswer(question, product.parameters)
    : null;

  res.json({
    query:           partNumber,
    mode:            "digikey_lookup",
    sandbox:         isSandbox,
    lookup_strategy: strategy,
    best_match:      product,
    specific_answer: specificAnswer,
  });
});

export default router;
