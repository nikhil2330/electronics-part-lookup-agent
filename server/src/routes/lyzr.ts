import { randomUUID } from "node:crypto";
import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";

const router: IRouter = Router();

const LYZR_CHAT_URL = "https://agent-prod.studio.lyzr.ai/v3/inference/chat/";

const ChatHistoryItem = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().trim().min(1).max(4000),
});

const ActiveContext = z.object({
  last_user_request: z.string().trim().max(1200).optional(),
  last_search_intent: z.string().trim().max(1200).optional(),
  last_supplier: z.string().trim().max(80).optional(),
  product_summary: z.string().trim().max(2400).optional(),
  candidates: z.array(z.string().trim().max(240)).max(8).optional(),
});

const LyzrChatRequest = z.object({
  message: z.string().trim().min(1, "message is required"),
  session_id: z.string().trim().min(1).optional(),
  history: z.array(ChatHistoryItem).max(10).optional(),
  active_context: ActiveContext.optional(),
});

function readRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

function getStringField(value: unknown, keys: string[]): string | null {
  if (!value || typeof value !== "object") return null;

  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const field = record[key];
    if (typeof field === "string" && field.trim() !== "") {
      return field;
    }
  }

  return null;
}

function extractReply(raw: unknown): string {
  if (typeof raw === "string") return raw;

  const direct = getStringField(raw, [
    "reply",
    "response",
    "answer",
    "message",
    "output",
    "text",
    "content",
  ]);
  if (direct) return direct;

  if (raw && typeof raw === "object") {
    const record = raw as Record<string, unknown>;

    for (const key of ["data", "result", "payload"]) {
      if (record[key]) {
        const nested = extractReply(record[key]);
        if (nested && nested !== JSON.stringify(record[key])) return nested;
      }
    }

    if (Array.isArray(record["choices"])) {
      const firstChoice = record["choices"][0];
      const choiceReply = extractReply(firstChoice);
      if (choiceReply) return choiceReply;
    }
  }

  return JSON.stringify(raw);
}

function compact(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1).trim()}...`;
}

function buildContextualMessage(data: z.infer<typeof LyzrChatRequest>): string {
  const history = data.history ?? [];
  const context = data.active_context;

  if (!history.length && !context) {
    return data.message;
  }

  const sections = [
    "You are answering inside an electronics parts chat app.",
    "Use the supplied context to resolve follow-up phrases like it, that, above, previous, this part, those parts, product details, and find it in Mouser/DigiKey.",
    "Do not switch to unrelated example parts when recent context identifies the user's intended part, search, supplier, or product candidate.",
    "If the current request asks for a supplier search, apply it to the latest relevant search intent or product candidate.",
  ];

  if (context) {
    const contextLines: string[] = [];

    if (context.last_user_request) {
      contextLines.push(`Last user request: ${compact(context.last_user_request, 800)}`);
    }
    if (context.last_search_intent) {
      contextLines.push(`Latest search intent: ${compact(context.last_search_intent, 800)}`);
    }
    if (context.last_supplier) {
      contextLines.push(`Latest supplier: ${compact(context.last_supplier, 80)}`);
    }
    if (context.product_summary) {
      contextLines.push(`Latest product/result context: ${compact(context.product_summary, 1800)}`);
    }
    if (context.candidates?.length) {
      contextLines.push(`Candidate parts/products: ${context.candidates.map((item) => compact(item, 160)).join("; ")}`);
    }

    if (contextLines.length) {
      sections.push(`Active context:\n${contextLines.join("\n")}`);
    }
  }

  if (history.length) {
    sections.push(
      `Recent conversation:\n${history
        .map((item) => `${item.role.toUpperCase()}: ${compact(item.content, 900)}`)
        .join("\n")}`,
    );
  }

  sections.push(`Current user message:\n${data.message}`);

  return sections.join("\n\n");
}

router.post("/lyzr-chat", async (req: Request, res: Response) => {
  const parsed = LyzrChatRequest.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid request body",
      details: parsed.error.flatten(),
    });
    return;
  }

  let apiKey: string;
  let agentId: string;
  let userId: string;

  try {
    apiKey = readRequiredEnv("LYZR_API_KEY");
    agentId = readRequiredEnv("LYZR_AGENT_ID");
    userId = readRequiredEnv("LYZR_USER_ID");
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : "Missing Lyzr configuration",
    });
    return;
  }

  const sessionId = parsed.data.session_id ?? randomUUID();
  const contextualMessage = buildContextualMessage(parsed.data);

  try {
    const response = await fetch(LYZR_CHAT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify({
        user_id: userId,
        agent_id: agentId,
        session_id: sessionId,
        message: contextualMessage,
      }),
    });

    const contentType = response.headers.get("content-type") ?? "";
    const raw = contentType.includes("application/json")
      ? await response.json()
      : await response.text();

    if (!response.ok) {
      res.status(response.status).json({
        error: "Lyzr request failed",
        session_id: sessionId,
        raw,
      });
      return;
    }

    res.json({
      reply: extractReply(raw),
      session_id: sessionId,
      raw,
    });
  } catch (err) {
    req.log.error({ err }, "Lyzr chat request failed");
    res.status(502).json({
      error: "Unable to reach Lyzr",
      session_id: sessionId,
      details: err instanceof Error ? err.message : String(err),
    });
  }
});

export default router;
