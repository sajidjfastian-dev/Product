using Microsoft.EntityFrameworkCore;

namespace SampleApi.Data;

public static class ProductDbSchema
{
    public static async Task EnsureExtendedSchemaAsync(
        ProductDbContext db,
        CancellationToken cancellationToken = default)
    {
        await db.Database.ExecuteSqlRawAsync(
            """
            IF COL_LENGTH(N'dbo.Products', N'Barcode') IS NULL
                ALTER TABLE [dbo].[Products] ADD [Barcode] nvarchar(64) NULL;
            IF COL_LENGTH(N'dbo.Products', N'Sku') IS NULL
                ALTER TABLE [dbo].[Products] ADD [Sku] nvarchar(64) NULL;
            IF COL_LENGTH(N'dbo.Products', N'Description') IS NULL
                ALTER TABLE [dbo].[Products] ADD [Description] nvarchar(2000) NULL;
            IF COL_LENGTH(N'dbo.Products', N'Location') IS NULL
                ALTER TABLE [dbo].[Products] ADD [Location] nvarchar(120) NULL;
            IF COL_LENGTH(N'dbo.Products', N'Brand') IS NULL
                ALTER TABLE [dbo].[Products] ADD [Brand] nvarchar(120) NULL;
            IF COL_LENGTH(N'dbo.Products', N'CreatedAtUtc') IS NULL
                ALTER TABLE [dbo].[Products] ADD [CreatedAtUtc] datetime2 NOT NULL
                    CONSTRAINT [DF_Products_CreatedAtUtc] DEFAULT SYSUTCDATETIME();

            IF OBJECT_ID(N'dbo.ProductImages', N'U') IS NULL
            BEGIN
                CREATE TABLE [dbo].[ProductImages] (
                    [Id] uniqueidentifier NOT NULL CONSTRAINT [PK_ProductImages] PRIMARY KEY,
                    [ProductId] uniqueidentifier NOT NULL,
                    [FileName] nvarchar(255) NOT NULL,
                    [ContentType] nvarchar(32) NOT NULL,
                    [ContentLength] int NOT NULL,
                    [Data] varbinary(max) NOT NULL,
                    [SortOrder] int NOT NULL,
                    [CreatedAtUtc] datetime2 NOT NULL
                        CONSTRAINT [DF_ProductImages_CreatedAtUtc] DEFAULT SYSUTCDATETIME(),
                    CONSTRAINT [FK_ProductImages_Products_ProductId]
                        FOREIGN KEY ([ProductId]) REFERENCES [dbo].[Products] ([Id]) ON DELETE CASCADE
                );
            END;
            """,
            cancellationToken);

        await db.Database.ExecuteSqlRawAsync(
            """
            IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_ProductImages_ProductId_SortOrder')
                CREATE INDEX [IX_ProductImages_ProductId_SortOrder]
                    ON [dbo].[ProductImages] ([ProductId], [SortOrder]);
            IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_Products_Barcode')
                EXEC(N'CREATE UNIQUE INDEX [IX_Products_Barcode] ON [dbo].[Products] ([Barcode]) WHERE [Barcode] IS NOT NULL AND [Barcode] <> N'''';');
            IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_Products_Sku')
                EXEC(N'CREATE UNIQUE INDEX [IX_Products_Sku] ON [dbo].[Products] ([Sku]) WHERE [Sku] IS NOT NULL AND [Sku] <> N'''';');
            """,
            cancellationToken);
    }
}
