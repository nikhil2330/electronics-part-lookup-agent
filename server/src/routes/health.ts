import { Router, type IRouter } from "express";
import { z } from "zod";

const router: IRouter = Router();

const HealthCheckResponse = z.object({ status: z.string() });

function sendHealth(res: Parameters<Parameters<typeof router.get>[1]>[1]) {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
}

router.get("/health", (_req, res) => {
  sendHealth(res);
});

router.get("/healthz", (_req, res) => {
  sendHealth(res);
});

export default router;
