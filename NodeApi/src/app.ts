import { timingSafeEqual } from "node:crypto";
import cookieParser from "cookie-parser";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { authRouter, seedRoles } from "./auth.js";
import { customerAssistantRouter, customerStoreRouter } from "./customerAssistant.js";
import { getPool, sql } from "./db.js";
import {
  auditRouter, inventoryRouter, purchasesRouter, reportsRouter, salesRouter,
} from "./operations.js";
import { productsRouter } from "./products.js";
import { ensureSchema } from "./schema.js";
import { requirePermission, requireUser } from "./security.js";

export async function createApp() {
  const app = express();
  const frontendOrigin = process.env.FRONTEND_ORIGIN ?? "http://localhost:8081";
  app.disable("x-powered-by");
  app.use(helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
    contentSecurityPolicy: {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        "img-src": ["'self'", "data:", "blob:"],
      },
    },
  }));
  app.use(cors({
    origin: frontendOrigin,
    credentials: true,
    allowedHeaders: ["Content-Type", "X-CSRF-TOKEN"],
    methods: ["GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS"],
  }));
  app.use(cookieParser());
  app.use(express.json({ limit: "1mb" }));

  app.use("/api", (request: Request, response: Response, next: NextFunction) => {
    if (["GET", "HEAD", "OPTIONS", "TRACE"].includes(request.method)) {
      next();
      return;
    }
    const cookie = request.cookies?.["Stockroom.Csrf"] as string | undefined;
    const header = request.header("X-CSRF-TOKEN");
    const expected = Buffer.from(cookie ?? "");
    const actual = Buffer.from(header ?? "");
    if (!cookie || !header || expected.length !== actual.length
      || !timingSafeEqual(expected, actual)) {
      response.status(400).json({ message: "A valid CSRF token is required. Refresh the page and try again." });
      return;
    }
    next();
  });

  app.get("/health", async (_request, response) => {
    await (await getPool()).request().query("SELECT 1");
    response.json({ status: "Healthy" });
  });

  const loginLimiter = rateLimit({
    windowMs: 60_000, limit: 10, standardHeaders: "draft-7", legacyHeaders: false,
    message: { message: "Too many sign-in attempts. Try again shortly." },
  });
  const bootstrapLimiter = rateLimit({
    windowMs: 5 * 60_000, limit: 3, standardHeaders: "draft-7", legacyHeaders: false,
    message: { message: "Too many setup attempts. Try again shortly." },
  });
  const assistantLimiter = rateLimit({
    windowMs: 60_000, limit: 12, standardHeaders: "draft-7", legacyHeaders: false,
    message: { message: "The shopping assistant is receiving too many requests. Try again shortly." },
  });
  app.use("/api/auth/login", loginLimiter);
  app.use("/api/auth/bootstrap", bootstrapLimiter);
  app.use("/api/customer-assistant/chat", assistantLimiter);
  app.use("/api/customer-assistant", customerAssistantRouter);
  app.use("/api/store", customerStoreRouter);
  app.use("/api/auth", authRouter);
  app.use("/api/products", productsRouter);
  app.use("/api/inventory", inventoryRouter);
  app.use("/api/reports", reportsRouter);
  app.use("/api/audit", auditRouter);
  app.use("/api/sales", salesRouter);
  app.use("/api/purchases", purchasesRouter);
  app.get("/api/inventory/barcode/:productId", requireUser, requirePermission("inventory.read"), async (request, response) => {
    const result = await (await getPool()).request().input("id", sql.UniqueIdentifier, request.params.productId)
      .query<{ Barcode: string | null; Name: string; Sku: string | null }>("SELECT Barcode, Name, Sku FROM dbo.Products WHERE Id=@id");
    const product = result.recordset[0];
    if (!product) { response.sendStatus(404); return; }
    response.json({ format: "CODE128", value: product.Barcode ?? "", product: product.Name, sku: product.Sku ?? "" });
  });

  app.use((request, response) => {
    response.status(404).json({ message: `No API route for ${request.method} ${request.path}.` });
  });
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof SyntaxError && "status" in error && error.status === 400) {
      response.status(400).json({ message: "Request body must be valid JSON." });
      return;
    }
    if (error instanceof Error && error.name === "MulterError") {
      response.status(400).json({ message: "Image upload is invalid or exceeds the file limits." });
      return;
    }
    console.error("API request failed", error);
    response.status(500).json({ message: "The service could not complete the request." });
  });

  await ensureSchema();
  await seedRoles();
  return app;
}
