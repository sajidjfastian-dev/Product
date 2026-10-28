import { randomUUID } from "node:crypto";
import PDFDocument from "pdfkit";
import { Router, type Request, type Response } from "express";
import multer from "multer";
import { getPool, sql } from "./db.js";
import { requirePermission, requireUser } from "./security.js";

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 8, fileSize: 8 * 1024 * 1024 },
  fileFilter: (_request, file, callback) => {
    if (["image/jpeg", "image/png", "image/webp"].includes(file.mimetype)) {
      callback(null, true);
      return;
    }
    callback(new multer.MulterError("LIMIT_UNEXPECTED_FILE", file.fieldname));
  },
});
const sortColumns: Record<string, string> = {
  name: "p.Name", sku: "p.Sku", barcode: "p.Barcode", category: "p.Category",
  brand: "p.Brand", location: "p.Location", price: "p.Price", stock: "p.Stock",
};

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function routeParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function validImageSignature(file: Express.Multer.File): boolean {
  if (file.mimetype === "image/jpeg") {
    return file.buffer.length >= 3 && file.buffer[0] === 0xff
      && file.buffer[1] === 0xd8 && file.buffer[2] === 0xff;
  }
  if (file.mimetype === "image/png") {
    return file.buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  }
  return file.mimetype === "image/webp" && file.buffer.length >= 12
    && file.buffer.toString("ascii", 0, 4) === "RIFF"
    && file.buffer.toString("ascii", 8, 12) === "WEBP";
}

function productJson(row: Record<string, unknown>, images: unknown[] = []) {
  return {
    id: row.Id, name: row.Name, category: row.Category, price: Number(row.Price),
    stock: row.Stock, reorderLevel: row.ReorderLevel, barcode: row.Barcode, sku: row.Sku,
    description: row.Description, location: row.Location, brand: row.Brand,
    createdAtUtc: row.CreatedAtUtc, images,
  };
}

async function writeAudit(
  executor: sql.ConnectionPool | sql.Transaction,
  request: Request,
  action: string,
  entityType: string,
  entityId: string,
  details: object | null,
): Promise<void> {
  const auditRequest = executor instanceof sql.Transaction
    ? new sql.Request(executor)
    : executor.request();
  await auditRequest
    .input("auditId", sql.UniqueIdentifier, randomUUID())
    .input("userId", sql.UniqueIdentifier, request.principal!.id)
    .input("email", sql.NVarChar(254), request.principal!.email)
    .input("action", sql.NVarChar(80), action)
    .input("entityType", sql.NVarChar(80), entityType)
    .input("entityId", sql.NVarChar(120), entityId)
    .input("details", sql.NVarChar(2000), details ? JSON.stringify(details) : null)
    .query(`INSERT INTO dbo.AuditEvents(Id, UserId, UserEmail, Action, EntityType, EntityId, Details)
      VALUES(@auditId, @userId, @email, @action, @entityType, @entityId, @details)`);
}

export const productsRouter = Router();
productsRouter.use(requireUser, requirePermission("products.read"));

productsRouter.get("/", async (request, response) => {
  const { search, category, location, brand, stock, minPrice, maxPrice, sortBy, sortDirection } = request.query;
  const pageSize = Math.min(100, Math.max(1, Number(request.query.pageSize) || 20));
  let page = Math.max(1, Number(request.query.page) || 1);
  const filters = ["p.IsActive = 1"];
  const base = (await getPool()).request();
  const add = (name: string, value: unknown, type: sql.ISqlType): string => {
    base.input(name, type, value);
    return `@${name}`;
  };
  if (typeof search === "string" && search.trim()) {
    const term = add("search", `%${search.trim()}%`, sql.NVarChar(200));
    filters.push(`(p.Name LIKE ${term} OR p.Sku LIKE ${term} OR p.Barcode LIKE ${term} OR p.Category LIKE ${term} OR p.Brand LIKE ${term} OR p.Location LIKE ${term})`);
  }
  if (typeof category === "string" && category.trim()) filters.push(`p.Category = ${add("category", category.trim(), sql.NVarChar(80))}`);
  if (typeof location === "string" && location.trim()) filters.push(`p.Location LIKE ${add("location", `%${location.trim()}%`, sql.NVarChar(120))}`);
  if (typeof brand === "string" && brand.trim()) filters.push(`p.Brand = ${add("brand", brand.trim(), sql.NVarChar(120))}`);
  if (stock === "in") filters.push("p.Stock > 0");
  if (stock === "out") filters.push("p.Stock = 0");
  if (minPrice !== undefined && Number.isFinite(Number(minPrice))) filters.push(`p.Price >= ${add("minPrice", Number(minPrice), sql.Decimal(18, 2))}`);
  if (maxPrice !== undefined && Number.isFinite(Number(maxPrice))) filters.push(`p.Price <= ${add("maxPrice", Number(maxPrice), sql.Decimal(18, 2))}`);
  const where = filters.join(" AND ");
  const pool = await getPool();
  const count = await base.query<{ TotalCount: number }>(`SELECT COUNT(*) AS TotalCount FROM dbo.Products p WHERE ${where}`);
  const totalCount = count.recordset[0]?.TotalCount ?? 0;
  page = Math.min(page, Math.max(1, Math.ceil(totalCount / pageSize)));
  const sort = sortColumns[String(sortBy).toLowerCase()] ?? "p.Name";
  const direction = String(sortDirection).toLowerCase() === "desc" ? "DESC" : "ASC";
  base.input("offset", sql.Int, (page - 1) * pageSize).input("pageSize", sql.Int, pageSize);
  const result = await base.query<Record<string, unknown>>(
    `SELECT p.Id, p.Name, p.Category, p.Price, p.Stock, p.ReorderLevel, p.Barcode, p.Sku,
       p.Description, p.Location, p.Brand, p.CreatedAtUtc
     FROM dbo.Products p WHERE ${where} ORDER BY ${sort} ${direction}, p.Name
     OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY`);
  const items = await Promise.all(result.recordset.map(async (product) => {
    const images = await pool.request().input("id", sql.UniqueIdentifier, product.Id)
      .query<{ Id: string; FileName: string; ContentType: string; SortOrder: number }>(
        `SELECT Id, FileName, ContentType, SortOrder FROM dbo.ProductImages
         WHERE ProductId = @id ORDER BY SortOrder`);
    return productJson(product, images.recordset.map((image) => ({
      id: image.Id, fileName: image.FileName, contentType: image.ContentType, sortOrder: image.SortOrder,
    })));
  }));
  response.json({ items, totalCount, page, pageSize });
});

productsRouter.get("/pdf", requirePermission("reports.read"), async (_request, response) => {
  const pool = await getPool();
  const products = await pool.request().query<{ Name: string; Category: string; Sku: string | null; Barcode: string | null; Stock: number; Price: number }>(
    "SELECT Name, Category, Sku, Barcode, Stock, Price FROM dbo.Products WHERE IsActive = 1 ORDER BY Name");
  const document = new PDFDocument({ margin: 40 });
  const chunks: Buffer[] = [];
  document.on("data", (chunk: Buffer) => chunks.push(chunk));
  const completed = new Promise<Buffer>((resolve, reject) => {
    document.on("end", () => resolve(Buffer.concat(chunks)));
    document.on("error", reject);
  });
  document.fontSize(20).fillColor("#194733").text("Stockroom product inventory");
  document.moveDown(0.5).fontSize(9).fillColor("#53645a")
    .text(`Generated ${new Date().toISOString()} · ${products.recordset.length} active products`);
  document.moveDown();
  for (const product of products.recordset) {
    if (document.y > 730) document.addPage();
    document.fontSize(10).fillColor("#202923")
      .text(`${product.Name}  |  ${product.Category}  |  SKU: ${product.Sku ?? "—"}  |  Barcode: ${product.Barcode ?? "—"}  |  Stock: ${product.Stock}  |  $${Number(product.Price).toFixed(2)}`);
  }
  document.end();
  response.type("application/pdf").attachment("products.pdf").send(await completed);
});

productsRouter.post("/", requirePermission("products.write"), async (request, response) => {
  const body = request.body as Record<string, unknown>;
  const errors = validateProduct(body);
  if (errors.length) { response.status(400).json({ message: errors.join(" ") }); return; }
  const pool = await getPool();
  const barcode = typeof body.barcode === "string" && body.barcode.trim()
    ? body.barcode.trim()
    : `INV${Number((await pool.request().query<{ Value: number }>("SELECT NEXT VALUE FOR dbo.ProductBarcodeSequence AS Value")).recordset[0]?.Value).toString().padStart(10, "0")}`;
  const id = randomUUID();
  try {
    const transaction = new sql.Transaction(pool);
    await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
    try {
      await new sql.Request(transaction)
        .input("id", sql.UniqueIdentifier, id)
        .input("name", sql.NVarChar(120), String(body.name).trim())
        .input("category", sql.NVarChar(80), String(body.category).trim())
        .input("price", sql.Decimal(18, 2), Number(body.price))
        .input("stock", sql.Int, Number(body.stock))
        .input("reorder", sql.Int, Number(body.reorderLevel ?? 10))
        .input("barcode", sql.NVarChar(64), barcode)
        .input("sku", sql.NVarChar(64), nullable(body.sku))
        .input("description", sql.NVarChar(2000), nullable(body.description))
        .input("location", sql.NVarChar(120), nullable(body.location))
        .input("brand", sql.NVarChar(120), nullable(body.brand))
        .query(`INSERT INTO dbo.Products(Id, Name, Category, Price, Stock, ReorderLevel, IsActive, Barcode, Sku, Description, Location, Brand)
          VALUES(@id, @name, @category, @price, @stock, @reorder, 1, @barcode, @sku, @description, @location, @brand)`);
      if (Number(body.stock) > 0) {
        await movement(transaction, request, id, "Initial stock", Number(body.stock), Number(body.stock), "Stock entered when product was created", null);
      }
      await writeAudit(transaction, request, "Product created", "Product", id, {
        name: String(body.name).trim(), barcode, sku: nullable(body.sku), stock: Number(body.stock),
      });
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
    const result = await pool.request().input("id", sql.UniqueIdentifier, id)
      .query<Record<string, unknown>>("SELECT * FROM dbo.Products WHERE Id = @id");
    response.status(201).location(`/api/products/${id}`).json(productJson(result.recordset[0]!));
  } catch (error) {
    if ([2601, 2627].includes((error as { number?: number }).number ?? 0)) {
      response.status(409).json({ message: "Barcode and SKU must be unique." });
      return;
    }
    throw error;
  }
});

productsRouter.put("/:id", requirePermission("products.write"), async (request, response) => {
  const id = routeParam(request.params.id);
  if (!isUuid(id)) { response.sendStatus(404); return; }
  const body = request.body as Record<string, unknown>;
  const errors = validateProduct(body);
  if (errors.length) { response.status(400).json({ message: errors.join(" ") }); return; }
  const pool = await getPool();
  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  let transactionFinished = false;
  try {
    const before = await new sql.Request(transaction).input("id", sql.UniqueIdentifier, id)
      .query<{ Stock: number; IsActive: boolean }>("SELECT Stock, IsActive FROM dbo.Products WITH (UPDLOCK) WHERE Id = @id");
    if (!before.recordset[0]) { await transaction.rollback(); response.sendStatus(404); return; }
    if (!before.recordset[0].IsActive) { await transaction.rollback(); response.status(409).json({ message: "Archived products cannot be edited." }); return; }
    const stock = Number(body.stock);
    const oldStock = before.recordset[0].Stock;
    await new sql.Request(transaction)
      .input("id", sql.UniqueIdentifier, id)
      .input("name", sql.NVarChar(120), String(body.name).trim())
      .input("category", sql.NVarChar(80), String(body.category).trim())
      .input("price", sql.Decimal(18, 2), Number(body.price))
      .input("stock", sql.Int, stock)
      .input("reorder", sql.Int, Number(body.reorderLevel ?? 10))
      .input("barcode", sql.NVarChar(64), nullable(body.barcode))
      .input("sku", sql.NVarChar(64), nullable(body.sku))
      .input("description", sql.NVarChar(2000), nullable(body.description))
      .input("location", sql.NVarChar(120), nullable(body.location))
      .input("brand", sql.NVarChar(120), nullable(body.brand))
      .query(`UPDATE dbo.Products SET Name=@name, Category=@category, Price=@price, Stock=@stock,
        ReorderLevel=@reorder, Barcode=@barcode, Sku=@sku, Description=@description, Location=@location, Brand=@brand
        WHERE Id=@id`);
    if (stock !== oldStock) {
      await movement(transaction, request, id, "Adjustment", stock - oldStock, stock, "Stock changed while editing product", null);
    }
    await writeAudit(transaction, request, "Product updated", "Product", id, {
      name: String(body.name).trim(), stock,
    });
    await transaction.commit();
    transactionFinished = true;
    const result = await pool.request().input("id", sql.UniqueIdentifier, id)
      .query<Record<string, unknown>>("SELECT * FROM dbo.Products WHERE Id = @id");
    response.json(productJson(result.recordset[0]!));
  } catch (error) {
    if (!transactionFinished) await transaction.rollback();
    if ([2601, 2627].includes((error as { number?: number }).number ?? 0)) {
      response.status(409).json({ message: "Barcode and SKU must be unique." });
      return;
    }
    throw error;
  }
});

productsRouter.post("/:id/images", requirePermission("products.write"), imageUpload.array("files", 8), async (request, response) => {
  const id = routeParam(request.params.id);
  if (!isUuid(id)) { response.sendStatus(404); return; }
  const files = request.files as Express.Multer.File[] | undefined;
  if (!files?.length) { response.status(400).json({ message: "Choose at least one JPEG, PNG, or WebP image up to 8 MB." }); return; }
  if (files.some((file) => !validImageSignature(file))) {
    response.status(400).json({ message: "The uploaded file content does not match a supported JPEG, PNG, or WebP image." });
    return;
  }
  const pool = await getPool();
  const transaction = new sql.Transaction(pool);
  await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  let transactionFinished = false;
  try {
    const product = await new sql.Request(transaction).input("id", sql.UniqueIdentifier, id)
      .query("SELECT Id FROM dbo.Products WITH (UPDLOCK, HOLDLOCK) WHERE Id=@id AND IsActive=1");
    if (!product.recordset[0]) {
      await transaction.rollback();
      transactionFinished = true;
      response.sendStatus(404);
      return;
    }
    const count = await new sql.Request(transaction).input("id", sql.UniqueIdentifier, id)
      .query<{ Total: number }>("SELECT COUNT(*) AS Total FROM dbo.ProductImages WITH (UPDLOCK, HOLDLOCK) WHERE ProductId=@id");
    if ((count.recordset[0]?.Total ?? 0) + files.length > 8) {
      await transaction.rollback();
      transactionFinished = true;
      response.status(400).json({ message: "A product can have up to 8 images." });
      return;
    }
    let sortOrder = count.recordset[0]?.Total ?? 0;
    const images = [];
    for (const file of files) {
      const imageId = randomUUID();
      await new sql.Request(transaction).input("id", sql.UniqueIdentifier, imageId)
        .input("product", sql.UniqueIdentifier, id)
        .input("name", sql.NVarChar(255), file.originalname.slice(0, 255))
        .input("type", sql.NVarChar(32), file.mimetype)
        .input("length", sql.Int, file.size)
        .input("data", sql.VarBinary(sql.MAX), file.buffer)
        .input("sort", sql.Int, sortOrder)
        .query(`INSERT INTO dbo.ProductImages(Id, ProductId, FileName, ContentType, ContentLength, Data, SortOrder)
          VALUES(@id, @product, @name, @type, @length, @data, @sort)`);
      images.push({ id: imageId, fileName: file.originalname.slice(0, 255), contentType: file.mimetype, sortOrder: sortOrder++ });
    }
    await writeAudit(transaction, request, "Product images uploaded", "Product", id, { count: files.length });
    await transaction.commit();
    transactionFinished = true;
    response.status(201).json({ images });
  } catch (error) {
    if (!transactionFinished) await transaction.rollback();
    throw error;
  }
});

productsRouter.get("/:id/images/:imageId", async (request, response) => {
  const productId = routeParam(request.params.id);
  const imageId = routeParam(request.params.imageId);
  if (!isUuid(productId) || !isUuid(imageId)) { response.sendStatus(404); return; }
  const image = await (await getPool()).request()
    .input("id", sql.UniqueIdentifier, imageId)
    .input("product", sql.UniqueIdentifier, productId)
    .query<{ ContentType: string; FileName: string; Data: Buffer }>(
      "SELECT ContentType, FileName, Data FROM dbo.ProductImages WHERE Id=@id AND ProductId=@product");
  const row = image.recordset[0];
  if (!row) { response.sendStatus(404); return; }
  response.type(row.ContentType).setHeader("Content-Disposition", `inline; filename="${row.FileName.replace(/["\\]/g, "")}"`).send(row.Data);
});

productsRouter.delete("/:id/images/:imageId", requirePermission("products.write"), async (request, response) => {
  const productId = routeParam(request.params.id);
  const imageId = routeParam(request.params.imageId);
  if (!isUuid(productId) || !isUuid(imageId)) { response.sendStatus(404); return; }
  const pool = await getPool();
  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  let transactionFinished = false;
  try {
    const exists = await new sql.Request(transaction).input("id", sql.UniqueIdentifier, imageId)
      .input("product", sql.UniqueIdentifier, productId)
      .query("SELECT Id FROM dbo.ProductImages WHERE Id=@id AND ProductId=@product");
    if (!exists.recordset[0]) {
      await transaction.rollback();
      transactionFinished = true;
      response.sendStatus(404);
      return;
    }
    const result = await new sql.Request(transaction).input("id", sql.UniqueIdentifier, imageId)
      .input("product", sql.UniqueIdentifier, productId)
      .query("DELETE FROM dbo.ProductImages WHERE Id=@id AND ProductId=@product");
    if (result.rowsAffected[0]) {
      await writeAudit(transaction, request, "Product image removed", "Product", productId, { imageId });
    }
    await transaction.commit();
    transactionFinished = true;
  } catch (error) {
    if (!transactionFinished) await transaction.rollback();
    throw error;
  }
  response.sendStatus(204);
});

productsRouter.delete("/:id", requirePermission("products.write"), async (request, response) => {
  const id = routeParam(request.params.id);
  if (!isUuid(id)) { response.sendStatus(404); return; }
  const pool = await getPool();
  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  let transactionFinished = false;
  try {
    const result = await new sql.Request(transaction).input("id", sql.UniqueIdentifier, id)
      .query("UPDATE dbo.Products SET IsActive=0 WHERE Id=@id AND IsActive=1");
    if (result.rowsAffected[0]) {
      await writeAudit(transaction, request, "Product archived", "Product", id, null);
    }
    await transaction.commit();
    transactionFinished = true;
    if (!result.rowsAffected[0]) { response.sendStatus(404); return; }
    response.sendStatus(204);
  } catch (error) {
    if (!transactionFinished) await transaction.rollback();
    throw error;
  }
});

function nullable(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function validateProduct(body: Record<string, unknown>): string[] {
  const errors: string[] = [];
  if (typeof body.name !== "string" || !body.name.trim() || body.name.length > 120) errors.push("Enter a product name up to 120 characters.");
  if (typeof body.category !== "string" || !body.category.trim() || body.category.length > 80) errors.push("Enter a category up to 80 characters.");
  if (!Number.isFinite(body.price) || Number(body.price) < 0) errors.push("Enter a valid non-negative price.");
  if (!Number.isInteger(body.stock) || Number(body.stock) < 0) errors.push("Enter a non-negative whole-number stock quantity.");
  if (body.reorderLevel !== undefined && (!Number.isInteger(body.reorderLevel) || Number(body.reorderLevel) < 0)) errors.push("Enter a non-negative whole-number reorder level.");
  for (const [field, max] of [
    ["barcode", 64], ["sku", 64], ["description", 2000],
    ["location", 120], ["brand", 120],
  ] as const) {
    if (body[field] !== undefined && body[field] !== null
      && (typeof body[field] !== "string" || body[field].length > max)) {
      errors.push(`${field} must be at most ${max} characters.`);
    }
  }
  return errors;
}

async function movement(
  transaction: sql.Transaction, request: Request, productId: string,
  type: string, quantity: number, balance: number, reason: string, reference: string | null,
): Promise<void> {
  await new sql.Request(transaction)
    .input("id", sql.UniqueIdentifier, randomUUID())
    .input("product", sql.UniqueIdentifier, productId)
    .input("type", sql.NVarChar(40), type)
    .input("change", sql.Int, quantity)
    .input("balance", sql.Int, balance)
    .input("reason", sql.NVarChar(300), reason)
    .input("reference", sql.NVarChar(120), reference)
    .input("user", sql.UniqueIdentifier, request.principal?.id ?? null)
    .input("email", sql.NVarChar(254), request.principal?.email ?? null)
    .query(`INSERT INTO dbo.InventoryMovements(Id, ProductId, MovementType, QuantityChange, BalanceAfter, Reason, Reference, CreatedByUserId, CreatedByEmail)
      VALUES(@id, @product, @type, @change, @balance, @reason, @reference, @user, @email)`);
}

export { isUuid, movement };
