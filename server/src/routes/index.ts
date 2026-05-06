import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import mouserRouter from "./mouser.js";
import digikeyRouter from "./digikey.js";
import lyzrRouter from "./lyzr.js";
import datasheetRouter from "./datasheet.js";
import openApiRouter from "./openapi.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(mouserRouter);
router.use(digikeyRouter);
router.use(lyzrRouter);
router.use(datasheetRouter);
router.use(openApiRouter);

export default router;
