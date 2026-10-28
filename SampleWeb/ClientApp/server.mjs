import express from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import { fileURLToPath } from "node:url";
import path from "node:path";

const app = express();
const port = Number(process.env.PORT ?? "8081");
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "dist");
const apiUpstream = process.env.API_UPSTREAM ?? "http://api:8080";

app.disable("x-powered-by");
app.get("/health", (_request, response) => response.json({ status: "Healthy" }));
app.get("/config.js", (_request, response) => {
  response.type("application/javascript").send("window.productCatalogConfig = { apiBaseUrl: '' };");
});
app.use(createProxyMiddleware({ target: apiUpstream, pathFilter: "/api" }));
app.use(express.static(root, { index: false, maxAge: "1h" }));
app.get(/.*/, (_request, response) => response.sendFile(path.join(root, "index.html")));
app.listen(port, "0.0.0.0", () => console.log(`Stockroom portal listening on port ${port}`));
