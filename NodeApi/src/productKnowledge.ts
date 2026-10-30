import { createHash } from "node:crypto";
import { getPool, sql } from "./db.js";

const collection = "stockroom-products";
const vectorSize = 1536;
const embeddingModel = "text-embedding-3-small";
const indexRefreshMilliseconds = 60_000;
const qdrantUrl = (process.env.QDRANT_URL ?? "http://localhost:6333").replace(/\/+$/, "");

interface ProductRecord {
  Id: string;
  Name: string;
  Category: string;
  Brand: string | null;
  Description: string | null;
  Sku: string | null;
  Barcode: string | null;
  Location: string | null;
  Price: number;
  Stock: number;
}

interface IndexedProduct extends ProductRecord {
  content: string;
  contentHash: string;
}

interface QdrantPoint {
  id: string;
  payload?: Record<string, unknown> | null;
}

export class ProductKnowledgeError extends Error {
  constructor(
    readonly service: "openai" | "qdrant",
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ProductKnowledgeError";
  }
}

let lastSuccessfulSync = 0;
let syncInFlight: Promise<void> | undefined;
let indexRevision = 0;

export function markProductIndexStale(): void {
  indexRevision += 1;
  lastSuccessfulSync = 0;
}

export function productDocument(product: Pick<
  ProductRecord, "Name" | "Category" | "Brand" | "Description" | "Sku" | "Barcode" | "Location"
>): string {
  return [
    `Product: ${product.Name}`,
    `Category: ${product.Category}`,
    product.Brand && `Brand: ${product.Brand}`,
    product.Sku && `SKU: ${product.Sku}`,
    product.Barcode && `Barcode: ${product.Barcode}`,
    product.Location && `Location: ${product.Location}`,
    product.Description && `Description: ${product.Description}`,
  ].filter(Boolean).join("\n");
}

async function qdrantRequest<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${qdrantUrl}${path}`, {
      ...init,
      headers: {
        ...(init?.headers ?? {}),
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
      },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new ProductKnowledgeError("qdrant", `Vector database request failed: ${String(error)}`);
  }

  if (!response.ok) {
    throw new ProductKnowledgeError("qdrant", `Vector database returned HTTP ${response.status}.`, response.status);
  }
  try {
    return await response.json() as T;
  } catch (error) {
    throw new ProductKnowledgeError("qdrant", `Vector database returned invalid JSON: ${String(error)}`);
  }
}

async function embed(texts: string[]): Promise<number[][]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new ProductKnowledgeError("openai", "OPENAI_API_KEY is required for product vector search.");

  let response: Response;
  try {
    response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: embeddingModel, input: texts, dimensions: vectorSize }),
      signal: AbortSignal.timeout(25_000),
    });
  } catch (error) {
    throw new ProductKnowledgeError("openai", `Embedding provider request failed: ${String(error)}`);
  }

  if (!response.ok) {
    throw new ProductKnowledgeError("openai", `Embedding provider returned HTTP ${response.status}.`, response.status);
  }

  let result: unknown;
  try {
    result = await response.json() as unknown;
  } catch (error) {
    throw new ProductKnowledgeError("openai", `Embedding provider returned invalid JSON: ${String(error)}`);
  }
  if (!result || typeof result !== "object" || !("data" in result) || !Array.isArray(result.data)) {
    throw new ProductKnowledgeError("openai", "Embedding provider response is missing vectors.");
  }
  const rows = result.data as Array<{ index?: unknown; embedding?: unknown }>;
  const vectors: number[][] = Array(texts.length);
  for (const row of rows) {
    if (typeof row.index !== "number" || !Number.isInteger(row.index)
      || row.index < 0 || row.index >= texts.length || !Array.isArray(row.embedding)
      || row.embedding.length !== vectorSize
      || !row.embedding.every((value) => typeof value === "number" && Number.isFinite(value))) {
      throw new ProductKnowledgeError("openai", "Embedding provider returned an invalid vector.");
    }
    vectors[row.index] = row.embedding as number[];
  }
  if (vectors.some((vector) => !vector)) {
    throw new ProductKnowledgeError("openai", "Embedding provider returned an incomplete vector batch.");
  }
  return vectors;
}

async function ensureCollection(): Promise<void> {
  try {
    const result = await qdrantRequest<{
      result?: { config?: { params?: { vectors?: unknown } } };
    }>(`/collections/${collection}`);
    const vectors = result.result?.config?.params?.vectors;
    if (!vectors || typeof vectors !== "object" || Array.isArray(vectors)
      || !("size" in vectors) || vectors.size !== vectorSize) {
      throw new ProductKnowledgeError(
        "qdrant",
        `The ${collection} collection must use ${vectorSize}-dimension unnamed vectors.`,
      );
    }
    return;
  } catch (error) {
    if (!(error instanceof ProductKnowledgeError) || error.status !== 404) throw error;
  }
  await qdrantRequest(`/collections/${collection}`, {
    method: "PUT",
    body: JSON.stringify({ vectors: { size: vectorSize, distance: "Cosine" } }),
  });
}

async function scrollPoints(): Promise<QdrantPoint[]> {
  const points: QdrantPoint[] = [];
  let offset: string | number | undefined;
  for (let page = 0; page < 100; page += 1) {
    const result = await qdrantRequest<{
      result?: { points?: QdrantPoint[]; next_page_offset?: string | number | null };
    }>(`/collections/${collection}/points/scroll`, {
      method: "POST",
      body: JSON.stringify({ limit: 1000, offset, with_payload: ["contentHash"], with_vector: false }),
    });
    const rows = result.result?.points;
    if (!Array.isArray(rows)) throw new ProductKnowledgeError("qdrant", "Vector database returned an invalid index page.");
    points.push(...rows);
    const next = result.result?.next_page_offset;
    if (next === undefined || next === null) return points;
    offset = next;
  }
  throw new ProductKnowledgeError("qdrant", "Product vector index exceeds the supported synchronization page limit.");
}

async function synchronizeIndex(): Promise<void> {
  await ensureCollection();
  const result = await (await getPool()).request().query<ProductRecord>(`
    SELECT Id, Name, Category, Brand, Description, Sku, Barcode, Location, Price, Stock
    FROM dbo.Products
    WHERE IsActive = 1`);
  const products: IndexedProduct[] = result.recordset.map((product) => {
    const content = productDocument(product);
    return {
      ...product,
      content,
      contentHash: createHash("sha256").update(content).digest("hex"),
    };
  });
  const existing = await scrollPoints();
  const existingById = new Map(existing.map((point) => [
    point.id.toLowerCase(),
    typeof point.payload?.contentHash === "string" ? point.payload.contentHash : "",
  ]));
  const activeIds = new Set(products.map((product) => product.Id.toLowerCase()));
  const staleIds = existing.filter((point) => !activeIds.has(point.id.toLowerCase())).map((point) => point.id);
  if (staleIds.length) {
    await qdrantRequest(`/collections/${collection}/points/delete?wait=true`, {
      method: "POST",
      body: JSON.stringify({ points: staleIds }),
    });
  }

  const changed = products.filter((product) => existingById.get(product.Id.toLowerCase()) !== product.contentHash);
  for (let start = 0; start < changed.length; start += 100) {
    const batch = changed.slice(start, start + 100);
    const vectors = await embed(batch.map((product) => product.content));
    await qdrantRequest(`/collections/${collection}/points?wait=true`, {
      method: "PUT",
      body: JSON.stringify({
        points: batch.map((product, index) => ({
          id: product.Id,
          vector: vectors[index],
          payload: { contentHash: product.contentHash },
        })),
      }),
    });
  }
}

async function ensureProductIndex(): Promise<void> {
  if (syncInFlight) return syncInFlight;
  if (Date.now() - lastSuccessfulSync < indexRefreshMilliseconds) return;
  const revision = indexRevision;
  syncInFlight = synchronizeIndex().then(() => {
    lastSuccessfulSync = revision === indexRevision ? Date.now() : 0;
  }).finally(() => {
    syncInFlight = undefined;
  });
  return syncInFlight;
}

async function searchVectors(query: string): Promise<string[]> {
  await ensureProductIndex();
  const [vector] = await embed([query]);
  const result = await qdrantRequest<{
    result?: { points?: Array<{ id: string | number; score: number }> };
  }>(`/collections/${collection}/points/query`, {
    method: "POST",
    body: JSON.stringify({
      query: vector,
      limit: 80,
      score_threshold: 0.2,
      with_payload: false,
      with_vector: false,
    }),
  });
  const points = result.result?.points;
  if (!Array.isArray(points)) throw new ProductKnowledgeError("qdrant", "Vector database returned invalid search results.");
  return points.slice(0, 80).map((point) => String(point.id));
}

async function loadInStockProducts(ids: string[]): Promise<ProductRecord[]> {
  if (!ids.length) return [];
  const request = (await getPool()).request();
  const parameters = ids.map((id, index) => {
    const name = `product${index}`;
    request.input(name, sql.UniqueIdentifier, id);
    return `@${name}`;
  });
  const result = await request.query<ProductRecord>(`
    SELECT Id, Name, Category, Brand, Description, Sku, Barcode, Location, Price, Stock
    FROM dbo.Products
    WHERE IsActive = 1 AND Stock > 0 AND Id IN (${parameters.join(",")})`);
  return result.recordset;
}

async function searchKeywordMatches(terms: string[], limit: number): Promise<ProductRecord[]> {
  if (!terms.length || limit <= 0) return [];
  const request = (await getPool()).request();
  const columns = [
    { column: "p.Name", weight: 6 },
    { column: "p.Sku", weight: 5 },
    { column: "p.Barcode", weight: 5 },
    { column: "p.Category", weight: 4 },
    { column: "p.Brand", weight: 3 },
    { column: "p.Location", weight: 2 },
    { column: "p.Description", weight: 1 },
  ];
  const filters = terms.map((term, index) => {
    const parameter = `term${index}`;
    request.input(parameter, sql.NVarChar(64), term);
    return `(${columns.map(({ column }) =>
      `CHARINDEX(@${parameter}, COALESCE(${column}, N'')) > 0`).join(" OR ")})`;
  });
  const relevance = terms.flatMap((_term, index) => columns.map(({ column, weight }) =>
    `CASE WHEN CHARINDEX(@term${index}, COALESCE(${column}, N'')) > 0 THEN ${weight} ELSE 0 END`))
    .join(" + ");
  request.input("limit", sql.Int, limit);
  const result = await request.query<ProductRecord>(`
    SELECT TOP (@limit) p.Id, p.Name, p.Category, p.Brand, p.Description, p.Sku,
      p.Barcode, p.Location, p.Price, p.Stock
    FROM dbo.Products p
    WHERE p.IsActive = 1 AND p.Stock > 0 AND (${filters.join(" OR ")})
    ORDER BY (${relevance}) DESC, p.Name`);
  return result.recordset;
}

export async function retrieveProductMatches(query: string, terms: string[], limit = 20): Promise<ProductRecord[]> {
  if (!terms.length) return [];

  const vectorIds = await searchVectors(query);
  const vectorProducts = await loadInStockProducts(vectorIds);
  const vectorById = new Map(vectorProducts.map((product) => [product.Id.toLowerCase(), product]));
  const ranked = vectorIds
    .map((id) => vectorById.get(id.toLowerCase()))
    .filter((product): product is ProductRecord => product !== undefined)
    .slice(0, limit);
  const seen = new Set(ranked.map((product) => product.Id.toLowerCase()));
  if (ranked.length < limit) {
    const keywordProducts = await searchKeywordMatches(terms, limit - ranked.length);
    for (const product of keywordProducts) {
      const id = product.Id.toLowerCase();
      if (!seen.has(id)) {
        ranked.push(product);
        seen.add(id);
      }
    }
  }
  return ranked;
}
