import "dotenv/config";
import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes/index.js";
import { logger } from "./lib/logger.js";

const app: Express = express();
const defaultAllowedOrigins = [
  "http://localhost:5173",
  "https://electronics-part-lookup-agent.vercel.app",
];

function envList(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((origin) => normalizeOrigin(origin))
    .filter(Boolean);
}

function normalizeOrigin(origin: string): string {
  return origin.trim().replace(/\/+$/, "");
}

const allowedOrigins = new Set([
  ...defaultAllowedOrigins,
  ...envList("CLIENT_ORIGIN"),
  ...envList("ALLOWED_ORIGINS"),
  ...envList("CORS_ORIGINS"),
]);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return { id: req.id, method: req.method, url: req.url?.split("?")[0] };
      },
      res(res) {
        return { statusCode: res.statusCode };
      },
    },
  }),
);
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.has(normalizeOrigin(origin))) {
        callback(null, true);
        return;
      }

      callback(new Error(`Origin ${origin} is not allowed by CORS`));
    },
    credentials: true,
  }),
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

export default app;
