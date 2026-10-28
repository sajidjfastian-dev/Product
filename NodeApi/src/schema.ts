import { getPool } from "./db.js";

export async function ensureSchema(): Promise<void> {
  const pool = await getPool();
  await pool.request().query(`
    IF OBJECT_ID(N'dbo.SalesOrders', N'U') IS NULL
    BEGIN
      CREATE TABLE dbo.SalesOrders (
        Id uniqueidentifier NOT NULL CONSTRAINT PK_SalesOrders PRIMARY KEY,
        Reference nvarchar(40) NOT NULL,
        CustomerName nvarchar(160) NULL,
        Subtotal decimal(18,2) NOT NULL,
        DiscountPercent decimal(5,2) NOT NULL,
        DiscountAmount decimal(18,2) NOT NULL,
        Total decimal(18,2) NOT NULL,
        CreatedByUserId uniqueidentifier NULL,
        CreatedByEmail nvarchar(254) NULL,
        CreatedAtUtc datetime2 NOT NULL CONSTRAINT DF_SalesOrders_CreatedAtUtc DEFAULT SYSUTCDATETIME()
      );
      CREATE UNIQUE INDEX IX_SalesOrders_Reference ON dbo.SalesOrders(Reference);
      CREATE INDEX IX_SalesOrders_CreatedAtUtc ON dbo.SalesOrders(CreatedAtUtc);
    END;
    IF OBJECT_ID(N'dbo.SaleItems', N'U') IS NULL
    BEGIN
      CREATE TABLE dbo.SaleItems (
        Id uniqueidentifier NOT NULL CONSTRAINT PK_SaleItems PRIMARY KEY,
        SaleId uniqueidentifier NOT NULL,
        ProductId uniqueidentifier NOT NULL,
        ProductName nvarchar(120) NOT NULL,
        Sku nvarchar(64) NULL,
        Quantity int NOT NULL,
        UnitPrice decimal(18,2) NOT NULL,
        DiscountPercent decimal(5,2) NOT NULL,
        DiscountAmount decimal(18,2) NOT NULL,
        LineTotal decimal(18,2) NOT NULL,
        CONSTRAINT FK_SaleItems_SalesOrders_SaleId FOREIGN KEY(SaleId) REFERENCES dbo.SalesOrders(Id),
        CONSTRAINT FK_SaleItems_Products_ProductId FOREIGN KEY(ProductId) REFERENCES dbo.Products(Id)
      );
      CREATE INDEX IX_SaleItems_ProductId ON dbo.SaleItems(ProductId);
    END;
    IF OBJECT_ID(N'dbo.PurchaseOrders', N'U') IS NULL
    BEGIN
      CREATE TABLE dbo.PurchaseOrders (
        Id uniqueidentifier NOT NULL CONSTRAINT PK_PurchaseOrders PRIMARY KEY,
        Reference nvarchar(40) NOT NULL,
        SupplierName nvarchar(160) NULL,
        Total decimal(18,2) NOT NULL,
        CreatedByUserId uniqueidentifier NULL,
        CreatedByEmail nvarchar(254) NULL,
        CreatedAtUtc datetime2 NOT NULL CONSTRAINT DF_PurchaseOrders_CreatedAtUtc DEFAULT SYSUTCDATETIME()
      );
      CREATE UNIQUE INDEX IX_PurchaseOrders_Reference ON dbo.PurchaseOrders(Reference);
      CREATE INDEX IX_PurchaseOrders_CreatedAtUtc ON dbo.PurchaseOrders(CreatedAtUtc);
    END;
    IF OBJECT_ID(N'dbo.PurchaseItems', N'U') IS NULL
    BEGIN
      CREATE TABLE dbo.PurchaseItems (
        Id uniqueidentifier NOT NULL CONSTRAINT PK_PurchaseItems PRIMARY KEY,
        PurchaseId uniqueidentifier NOT NULL,
        ProductId uniqueidentifier NOT NULL,
        ProductName nvarchar(120) NOT NULL,
        Sku nvarchar(64) NULL,
        Quantity int NOT NULL,
        UnitCost decimal(18,2) NOT NULL,
        LineTotal decimal(18,2) NOT NULL,
        CONSTRAINT FK_PurchaseItems_PurchaseOrders_PurchaseId FOREIGN KEY(PurchaseId) REFERENCES dbo.PurchaseOrders(Id),
        CONSTRAINT FK_PurchaseItems_Products_ProductId FOREIGN KEY(ProductId) REFERENCES dbo.Products(Id)
      );
      CREATE INDEX IX_PurchaseItems_ProductId ON dbo.PurchaseItems(ProductId);
    END;
  `);
}
