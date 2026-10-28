import { randomUUID } from "node:crypto";
import { Router } from "express";
import { getPool, sql } from "./db.js";
import { requirePermission, requireUser } from "./security.js";
import { isUuid, movement } from "./products.js";
import { calculateSaleTotals, roundCurrency } from "./pricing.js";

type OrderLineInput = { productId?: unknown; quantity?: unknown; discountPercent?: unknown; unitCost?: unknown };

function validPercent(value: unknown): value is number {
  return Number.isFinite(value) && Number(value) >= 0 && Number(value) <= 100;
}

class OrderValidationError extends Error {}

function csvCell(value: unknown) {
  const text = String(value ?? "");
  return `"${text.replace(/"/g, '""')}"`;
}

async function audit(
  transaction: sql.Transaction, request: import("express").Request,
  action: string, entityType: string, entityId: string, details: object,
) {
  await new sql.Request(transaction)
    .input("id", sql.UniqueIdentifier, randomUUID())
    .input("user", sql.UniqueIdentifier, request.principal!.id)
    .input("email", sql.NVarChar(254), request.principal!.email)
    .input("action", sql.NVarChar(80), action)
    .input("type", sql.NVarChar(80), entityType)
    .input("entity", sql.NVarChar(120), entityId)
    .input("details", sql.NVarChar(2000), JSON.stringify(details))
    .query(`INSERT INTO dbo.AuditEvents(Id, UserId, UserEmail, Action, EntityType, EntityId, Details)
      VALUES(@id, @user, @email, @action, @type, @entity, @details)`);
}

export const salesRouter = Router();
salesRouter.use(requireUser, requirePermission("sales.manage"));

salesRouter.post("/", async (request, response) => {
  const body = request.body as { customerName?: unknown; discountPercent?: unknown; items?: OrderLineInput[] };
  if (!Array.isArray(body.items) || body.items.length === 0 || body.items.length > 100
    || !body.items.every((item) => item && isUuid(String(item.productId))
      && Number.isInteger(item.quantity) && Number(item.quantity) > 0
      && Number.isSafeInteger(item.quantity) && validPercent(item.discountPercent ?? 0))
    || !validPercent(body.discountPercent ?? 0)
    || (body.customerName !== undefined && (typeof body.customerName !== "string" || body.customerName.length > 160))) {
    response.status(400).json({ message: "Add valid products and quantities. Discounts must be percentages between 0 and 100." });
    return;
  }
  if (new Set(body.items.map((item) => String(item.productId))).size !== body.items.length) {
    response.status(400).json({ message: "Add each product once and update its quantity on that line." });
    return;
  }

  const pool = await getPool();
  const transaction = new sql.Transaction(pool);
  await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  try {
    const saleId = randomUUID();
    const reference = `SAL-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${randomUUID().slice(0, 6).toUpperCase()}`;
    const prepared: Array<{
      id: string; productId: string; name: string; sku: string | null;
      quantity: number; price: number; discountPercent: number; discountAmount: number; total: number;
      stock: number;
    }> = [];
    for (const input of body.items) {
      const productId = String(input.productId);
      const row = await new sql.Request(transaction).input("id", sql.UniqueIdentifier, productId)
        .query<{ Id: string; Name: string; Sku: string | null; Price: number; Stock: number; IsActive: boolean }>(
          "SELECT Id, Name, Sku, Price, Stock, IsActive FROM dbo.Products WITH (UPDLOCK, ROWLOCK) WHERE Id=@id");
      const product = row.recordset[0];
      if (!product || !product.IsActive) throw new OrderValidationError("A selected product is not available.");
      const quantity = Number(input.quantity);
      if (product.Stock < quantity) throw new OrderValidationError(`${product.Name} has only ${product.Stock} units available.`);
      const price = Number(product.Price);
      const discountPercent = Number(input.discountPercent ?? 0);
      const gross = roundCurrency(price * quantity);
      const discountAmount = roundCurrency(gross * discountPercent / 100);
      prepared.push({
        id: randomUUID(), productId, name: product.Name, sku: product.Sku, quantity,
        price, discountPercent, discountAmount, total: roundCurrency(gross - discountAmount),
        stock: product.Stock - quantity,
      });
    }

    const discountPercent = Number(body.discountPercent ?? 0);
    const totals = calculateSaleTotals(
      prepared.map((item) => ({
        unitPrice: item.price, quantity: item.quantity, discountPercent: item.discountPercent,
      })),
      discountPercent,
    );
    const { subtotal, orderDiscount: discountAmount, total } = totals;
    await new sql.Request(transaction)
      .input("id", sql.UniqueIdentifier, saleId)
      .input("ref", sql.NVarChar(40), reference)
      .input("customer", sql.NVarChar(160), typeof body.customerName === "string" && body.customerName.trim() ? body.customerName.trim() : null)
      .input("subtotal", sql.Decimal(18, 2), subtotal)
      .input("percent", sql.Decimal(5, 2), discountPercent)
      .input("discount", sql.Decimal(18, 2), discountAmount)
      .input("total", sql.Decimal(18, 2), total)
      .input("user", sql.UniqueIdentifier, request.principal!.id)
      .input("email", sql.NVarChar(254), request.principal!.email)
      .query(`INSERT INTO dbo.SalesOrders(Id, Reference, CustomerName, Subtotal, DiscountPercent, DiscountAmount, Total, CreatedByUserId, CreatedByEmail)
        VALUES(@id, @ref, @customer, @subtotal, @percent, @discount, @total, @user, @email)`);

    for (const item of prepared) {
      await new sql.Request(transaction)
        .input("id", sql.UniqueIdentifier, item.id)
        .input("sale", sql.UniqueIdentifier, saleId)
        .input("product", sql.UniqueIdentifier, item.productId)
        .input("name", sql.NVarChar(120), item.name)
        .input("sku", sql.NVarChar(64), item.sku)
        .input("quantity", sql.Int, item.quantity)
        .input("price", sql.Decimal(18, 2), item.price)
        .input("percent", sql.Decimal(5, 2), item.discountPercent)
        .input("discount", sql.Decimal(18, 2), item.discountAmount)
        .input("total", sql.Decimal(18, 2), item.total)
        .query(`INSERT INTO dbo.SaleItems(Id, SaleId, ProductId, ProductName, Sku, Quantity, UnitPrice, DiscountPercent, DiscountAmount, LineTotal)
          VALUES(@id, @sale, @product, @name, @sku, @quantity, @price, @percent, @discount, @total)`);
      await new sql.Request(transaction).input("id", sql.UniqueIdentifier, item.productId)
        .input("quantity", sql.Int, item.quantity)
        .query("UPDATE dbo.Products SET Stock=Stock-@quantity WHERE Id=@id AND IsActive=1 AND Stock>=@quantity");
      await movement(transaction, request, item.productId, "Sale", -item.quantity, item.stock, `Sale ${reference}`, reference);
    }
    await audit(transaction, request, "Sale completed", "SalesOrder", saleId, { reference, total, discountPercent });
    await transaction.commit();
    response.status(201).json({
      id: saleId, reference, subtotal, discountPercent, discountAmount, total,
      items: prepared.map(({ id, productId, name, sku, quantity, price, discountPercent: lineDiscount, discountAmount: lineAmount, total: lineTotal, stock }) => ({
        id, productId, productName: name, sku, quantity, unitPrice: price,
        discountPercent: lineDiscount, discountAmount: lineAmount, lineTotal, stockAfter: stock,
      })),
    });
  } catch (error) {
    await transaction.rollback();
    if (error instanceof OrderValidationError) {
      response.status(400).json({ message: error.message });
      return;
    }
    throw error;
  }
});

salesRouter.get("/", async (request, response) => {
  const pageSize = Math.min(100, Math.max(1, Number(request.query.pageSize) || 20));
  const page = Math.max(1, Number(request.query.page) || 1);
  const pool = await getPool();
  const result = await pool.request().input("offset", sql.Int, (page - 1) * pageSize)
    .input("size", sql.Int, pageSize)
    .query<{ Id: string; Reference: string; CustomerName: string | null; Subtotal: number; DiscountPercent: number; DiscountAmount: number; Total: number; CreatedAtUtc: Date; ItemCount: number }>(`
      SELECT s.Id, s.Reference, s.CustomerName, s.Subtotal, s.DiscountPercent, s.DiscountAmount, s.Total, s.CreatedAtUtc,
        (SELECT SUM(i.Quantity) FROM dbo.SaleItems i WHERE i.SaleId=s.Id) AS ItemCount
      FROM dbo.SalesOrders s ORDER BY s.CreatedAtUtc DESC OFFSET @offset ROWS FETCH NEXT @size ROWS ONLY`);
  response.json(result.recordset.map((row) => ({
    id: row.Id, reference: row.Reference, customerName: row.CustomerName, subtotal: Number(row.Subtotal),
    discountPercent: Number(row.DiscountPercent), discountAmount: Number(row.DiscountAmount),
    total: Number(row.Total), itemCount: row.ItemCount, createdAtUtc: row.CreatedAtUtc,
  })));
});

export const purchasesRouter = Router();
purchasesRouter.use(requireUser, requirePermission("purchases.manage"));

purchasesRouter.post("/", async (request, response) => {
  const body = request.body as { supplierName?: unknown; items?: OrderLineInput[] };
  if (!Array.isArray(body.items) || body.items.length === 0 || body.items.length > 100
    || !body.items.every((item) => item && isUuid(String(item.productId))
      && Number.isSafeInteger(item.quantity) && Number(item.quantity) > 0
      && Number.isFinite(item.unitCost) && Number(item.unitCost) >= 0)
    || (body.supplierName !== undefined && (typeof body.supplierName !== "string" || body.supplierName.length > 160))) {
    response.status(400).json({ message: "Add valid products, quantities, and non-negative unit costs." });
    return;
  }

  const pool = await getPool();
  const transaction = new sql.Transaction(pool);
  await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  try {
    const purchaseId = randomUUID();
    const reference = `PUR-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${randomUUID().slice(0, 6).toUpperCase()}`;
    const prepared: Array<{ id: string; productId: string; name: string; sku: string | null; quantity: number; unitCost: number; total: number; stock: number }> = [];
    for (const input of body.items) {
      const productId = String(input.productId);
      const row = await new sql.Request(transaction).input("id", sql.UniqueIdentifier, productId)
        .query<{ Id: string; Name: string; Sku: string | null; Stock: number; IsActive: boolean }>(
          "SELECT Id, Name, Sku, Stock, IsActive FROM dbo.Products WITH (UPDLOCK, ROWLOCK) WHERE Id=@id");
      const product = row.recordset[0];
      if (!product || !product.IsActive) throw new OrderValidationError("A selected product is not available.");
      const quantity = Number(input.quantity);
      if (product.Stock + quantity > 2_147_483_647) throw new OrderValidationError(`The received quantity for ${product.Name} is too large.`);
      const unitCost = roundCurrency(Number(input.unitCost));
      prepared.push({
        id: randomUUID(), productId, name: product.Name, sku: product.Sku, quantity,
        unitCost, total: roundCurrency(quantity * unitCost), stock: product.Stock + quantity,
      });
    }
    const total = roundCurrency(prepared.reduce((sum, item) => sum + item.total, 0));
    await new sql.Request(transaction)
      .input("id", sql.UniqueIdentifier, purchaseId).input("ref", sql.NVarChar(40), reference)
      .input("supplier", sql.NVarChar(160), typeof body.supplierName === "string" && body.supplierName.trim() ? body.supplierName.trim() : null)
      .input("total", sql.Decimal(18, 2), total)
      .input("user", sql.UniqueIdentifier, request.principal!.id)
      .input("email", sql.NVarChar(254), request.principal!.email)
      .query(`INSERT INTO dbo.PurchaseOrders(Id, Reference, SupplierName, Total, CreatedByUserId, CreatedByEmail)
        VALUES(@id, @ref, @supplier, @total, @user, @email)`);
    for (const item of prepared) {
      await new sql.Request(transaction)
        .input("id", sql.UniqueIdentifier, item.id).input("purchase", sql.UniqueIdentifier, purchaseId)
        .input("product", sql.UniqueIdentifier, item.productId).input("name", sql.NVarChar(120), item.name)
        .input("sku", sql.NVarChar(64), item.sku).input("quantity", sql.Int, item.quantity)
        .input("cost", sql.Decimal(18, 2), item.unitCost).input("total", sql.Decimal(18, 2), item.total)
        .query(`INSERT INTO dbo.PurchaseItems(Id, PurchaseId, ProductId, ProductName, Sku, Quantity, UnitCost, LineTotal)
          VALUES(@id, @purchase, @product, @name, @sku, @quantity, @cost, @total)`);
      await new sql.Request(transaction).input("id", sql.UniqueIdentifier, item.productId)
        .input("quantity", sql.Int, item.quantity)
        .query("UPDATE dbo.Products SET Stock=Stock+@quantity WHERE Id=@id AND IsActive=1");
      await movement(transaction, request, item.productId, "Purchase", item.quantity, item.stock, `Goods received ${reference}`, reference);
    }
    await audit(transaction, request, "Purchase received", "PurchaseOrder", purchaseId, { reference, total });
    await transaction.commit();
    response.status(201).json({
      id: purchaseId, reference, total,
      items: prepared.map((item) => ({ productId: item.productId, productName: item.name, quantity: item.quantity, unitCost: item.unitCost, lineTotal: item.total, stockAfter: item.stock })),
    });
  } catch (error) {
    await transaction.rollback();
    if (error instanceof OrderValidationError) {
      response.status(400).json({ message: error.message });
      return;
    }
    throw error;
  }
});

purchasesRouter.get("/", async (request, response) => {
  const pageSize = Math.min(100, Math.max(1, Number(request.query.pageSize) || 20));
  const page = Math.max(1, Number(request.query.page) || 1);
  const result = await (await getPool()).request().input("offset", sql.Int, (page - 1) * pageSize)
    .input("size", sql.Int, pageSize)
    .query<{ Id: string; Reference: string; SupplierName: string | null; Total: number; CreatedAtUtc: Date }>(
      "SELECT Id, Reference, SupplierName, Total, CreatedAtUtc FROM dbo.PurchaseOrders ORDER BY CreatedAtUtc DESC OFFSET @offset ROWS FETCH NEXT @size ROWS ONLY");
  response.json(result.recordset.map((item) => ({
    id: item.Id, reference: item.Reference, supplierName: item.SupplierName,
    total: Number(item.Total), createdAtUtc: item.CreatedAtUtc,
  })));
});

export const inventoryRouter = Router();
inventoryRouter.use(requireUser, requirePermission("inventory.read"));
inventoryRouter.get("/movements", async (request, response) => {
  const pageSize = Math.min(200, Math.max(1, Number(request.query.pageSize) || 50));
  const page = Math.max(1, Number(request.query.page) || 1);
  const result = await (await getPool()).request().input("offset", sql.Int, (page - 1) * pageSize)
    .input("size", sql.Int, pageSize)
    .query<Record<string, unknown>>(`SELECT m.Id, m.ProductId, p.Name AS ProductName, p.Sku,
      m.MovementType, m.QuantityChange, m.BalanceAfter, m.Reason, m.Reference, m.CreatedByEmail, m.CreatedAtUtc
      FROM dbo.InventoryMovements m JOIN dbo.Products p ON p.Id=m.ProductId
      ORDER BY m.CreatedAtUtc DESC OFFSET @offset ROWS FETCH NEXT @size ROWS ONLY`);
  response.json({
    items: result.recordset.map((item) => ({
      id: item.Id, productId: item.ProductId, productName: item.ProductName, sku: item.Sku,
      movementType: item.MovementType, quantityChange: item.QuantityChange,
      balanceAfter: item.BalanceAfter, reason: item.Reason, reference: item.Reference,
      createdByEmail: item.CreatedByEmail, createdAtUtc: item.CreatedAtUtc,
    })),
    totalCount: result.recordset.length, page, pageSize,
  });
});

inventoryRouter.post("/adjustments", requirePermission("inventory.adjust"), async (request, response) => {
  const { productId, quantityChange, reason, reference } = request.body as Record<string, unknown>;
  if (!isUuid(String(productId)) || !Number.isSafeInteger(quantityChange) || Number(quantityChange) === 0
    || typeof reason !== "string" || !reason.trim() || reason.length > 300
    || (reference !== undefined && reference !== null && (typeof reference !== "string" || reference.length > 120))) {
    response.status(400).json({ message: "Enter a product, non-zero whole quantity, and a reason up to 300 characters." });
    return;
  }
  const pool = await getPool();
  const transaction = new sql.Transaction(pool);
  await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  try {
    const product = await new sql.Request(transaction).input("id", sql.UniqueIdentifier, productId)
      .query<{ Name: string; Stock: number; IsActive: boolean }>("SELECT Name, Stock, IsActive FROM dbo.Products WITH (UPDLOCK) WHERE Id=@id");
    const item = product.recordset[0];
    if (!item || !item.IsActive) throw new OrderValidationError("Product not found.");
    const balance = item.Stock + Number(quantityChange);
    if (!Number.isSafeInteger(balance) || balance < 0 || balance > 2_147_483_647) throw new OrderValidationError("The adjustment would result in an invalid stock balance.");
    await new sql.Request(transaction).input("id", sql.UniqueIdentifier, productId)
      .input("stock", sql.Int, balance).query("UPDATE dbo.Products SET Stock=@stock WHERE Id=@id");
    await movement(transaction, request, String(productId), "Adjustment", Number(quantityChange), balance, reason.trim(), typeof reference === "string" ? reference.trim() || null : null);
    await audit(transaction, request, "Inventory adjusted", "Product", String(productId), { quantityChange, balance, reason: reason.trim() });
    await transaction.commit();
    response.json({ productId, name: item.Name, stock: balance });
  } catch (error) {
    await transaction.rollback();
    if (error instanceof OrderValidationError) {
      response.status(400).json({ message: error.message });
      return;
    }
    throw error;
  }
});

export const reportsRouter = Router();
reportsRouter.use(requireUser, requirePermission("reports.read"));
reportsRouter.get("/dashboard", async (_request, response) => {
  const pool = await getPool();
  const stats = await pool.request().query<{
    ProductCount: number; UnitsOnHand: number; InventoryRetailValue: number;
    LowStockCount: number; OutOfStockCount: number;
  }>(`SELECT COUNT(*) AS ProductCount, COALESCE(SUM(CONVERT(bigint, Stock)), 0) AS UnitsOnHand,
    COALESCE(SUM(Price*Stock), 0) AS InventoryRetailValue,
    SUM(CASE WHEN Stock>0 AND Stock<=ReorderLevel THEN 1 ELSE 0 END) AS LowStockCount,
    SUM(CASE WHEN Stock=0 THEN 1 ELSE 0 END) AS OutOfStockCount
    FROM dbo.Products WHERE IsActive=1`);
  const low = await pool.request().query<Record<string, unknown>>(`SELECT TOP (10) Id, Name, Sku, Stock, ReorderLevel, Price
    FROM dbo.Products WHERE IsActive=1 AND Stock<=ReorderLevel ORDER BY Stock, Name`);
  const best = await pool.request().query<Record<string, unknown>>(`SELECT TOP (8) i.ProductId AS Id, i.ProductName AS Name,
    SUM(i.Quantity) AS UnitsSold,
    SUM(i.LineTotal - CASE WHEN s.Subtotal > 0
      THEN s.DiscountAmount * i.LineTotal / s.Subtotal ELSE 0 END) AS Revenue
    FROM dbo.SaleItems i JOIN dbo.SalesOrders s ON s.Id=i.SaleId
    GROUP BY i.ProductId, i.ProductName ORDER BY SUM(i.Quantity) DESC, SUM(i.LineTotal) DESC`);
  const trend = await pool.request().query<Record<string, unknown>>(`SELECT CAST(CreatedAtUtc AS date) AS Date,
    SUM(CASE WHEN QuantityChange>0 THEN CONVERT(bigint, QuantityChange) ELSE 0 END) AS Received,
    SUM(CASE WHEN QuantityChange<0 THEN -CONVERT(bigint, QuantityChange) ELSE 0 END) AS Issued,
    COUNT(*) AS Transactions FROM dbo.InventoryMovements
    WHERE CreatedAtUtc>=DATEADD(day, -13, CAST(SYSUTCDATETIME() AS date))
    GROUP BY CAST(CreatedAtUtc AS date) ORDER BY Date`);
  const recent = await pool.request().query<Record<string, unknown>>(`SELECT TOP (12) m.Id, m.ProductId, p.Name AS ProductName,
    p.Sku, m.MovementType, m.QuantityChange, m.BalanceAfter, m.Reason, m.Reference, m.CreatedByEmail, m.CreatedAtUtc
    FROM dbo.InventoryMovements m JOIN dbo.Products p ON p.Id=m.ProductId ORDER BY m.CreatedAtUtc DESC`);
  const stat = stats.recordset[0]!;
  response.json({
    productCount: stat.ProductCount, unitsOnHand: Number(stat.UnitsOnHand),
    inventoryRetailValue: Number(stat.InventoryRetailValue), lowStockCount: stat.LowStockCount ?? 0,
    outOfStockCount: stat.OutOfStockCount ?? 0,
    lowStock: low.recordset.map((item) => ({ ...item, price: Number(item.Price), id: item.Id, name: item.Name, sku: item.Sku, stock: item.Stock, reorderLevel: item.ReorderLevel })),
    bestSellingItems: best.recordset.map((item) => ({ id: item.Id, name: item.Name, unitsSold: item.UnitsSold, revenue: Number(item.Revenue) })),
    movementTrend: trend.recordset.map((item) => ({ date: item.Date, received: item.Received, issued: item.Issued, transactions: item.Transactions })),
    recentMovements: recent.recordset.map((item) => ({
      id: item.Id, productId: item.ProductId, productName: item.ProductName, sku: item.Sku,
      movementType: item.MovementType, quantityChange: item.QuantityChange, balanceAfter: item.BalanceAfter,
      reason: item.Reason, reference: item.Reference, createdByEmail: item.CreatedByEmail, createdAtUtc: item.CreatedAtUtc,
    })),
  });
});

reportsRouter.get("/inventory.csv", async (_request, response) => {
  const result = await (await getPool()).request().query<Record<string, unknown>>(
    "SELECT Name, Category, Sku, Barcode, Brand, Location, Stock, ReorderLevel, Price FROM dbo.Products WHERE IsActive=1 ORDER BY Name");
  const columns = ["Name", "Category", "Sku", "Barcode", "Brand", "Location", "Stock", "ReorderLevel", "Price"];
  const lines = [columns.join(","), ...result.recordset.map((row) => columns.map((column) => csvCell(row[column])).join(","))];
  response.type("text/csv").attachment("inventory.csv").send(`\uFEFF${lines.join("\r\n")}`);
});

reportsRouter.get("/movements.csv", async (_request, response) => {
  const result = await (await getPool()).request().query<Record<string, unknown>>(`SELECT p.Name AS Product, p.Sku, m.MovementType,
    m.QuantityChange, m.BalanceAfter, m.Reason, m.Reference, m.CreatedByEmail, m.CreatedAtUtc
    FROM dbo.InventoryMovements m JOIN dbo.Products p ON p.Id=m.ProductId ORDER BY m.CreatedAtUtc DESC`);
  const columns = ["Product", "Sku", "MovementType", "QuantityChange", "BalanceAfter", "Reason", "Reference", "CreatedByEmail", "CreatedAtUtc"];
  const lines = [columns.join(","), ...result.recordset.map((row) => columns.map((column) => csvCell(row[column])).join(","))];
  response.type("text/csv").attachment("movements.csv").send(`\uFEFF${lines.join("\r\n")}`);
});

export const auditRouter = Router();
auditRouter.use(requireUser, requirePermission("audit.read"));
auditRouter.get("/", async (request, response) => {
  const size = Math.min(200, Math.max(1, Number(request.query.pageSize) || 50));
  const page = Math.max(1, Number(request.query.page) || 1);
  const result = await (await getPool()).request().input("offset", sql.Int, (page - 1) * size)
    .input("size", sql.Int, size).query<Record<string, unknown>>(`SELECT Id, UserId, UserEmail, Action, EntityType, EntityId, Details, CreatedAtUtc
      FROM dbo.AuditEvents ORDER BY CreatedAtUtc DESC OFFSET @offset ROWS FETCH NEXT @size ROWS ONLY`);
  response.json({ items: result.recordset.map((item) => ({
    id: item.Id, userId: item.UserId, userEmail: item.UserEmail, action: item.Action,
    entityType: item.EntityType, entityId: item.EntityId, details: item.Details, createdAtUtc: item.CreatedAtUtc,
  })), totalCount: result.recordset.length, page, pageSize: size });
});
