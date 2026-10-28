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
            IF COL_LENGTH(N'dbo.Products', N'ReorderLevel') IS NULL
                ALTER TABLE [dbo].[Products] ADD [ReorderLevel] int NOT NULL
                    CONSTRAINT [DF_Products_ReorderLevel] DEFAULT 10;
            IF COL_LENGTH(N'dbo.Products', N'IsActive') IS NULL
                ALTER TABLE [dbo].[Products] ADD [IsActive] bit NOT NULL
                    CONSTRAINT [DF_Products_IsActive] DEFAULT 1;

            IF OBJECT_ID(N'dbo.PortalUsers', N'U') IS NULL
            BEGIN
                CREATE TABLE [dbo].[PortalUsers] (
                    [Id] uniqueidentifier NOT NULL CONSTRAINT [PK_PortalUsers] PRIMARY KEY,
                    [Email] nvarchar(254) NOT NULL,
                    [DisplayName] nvarchar(120) NOT NULL,
                    [PasswordHash] nvarchar(512) NOT NULL,
                    [SecurityStamp] nvarchar(36) NOT NULL CONSTRAINT [DF_PortalUsers_SecurityStamp] DEFAULT CONVERT(nvarchar(36), NEWID()),
                    [IsActive] bit NOT NULL CONSTRAINT [DF_PortalUsers_IsActive] DEFAULT 1,
                    [FailedLoginAttempts] int NOT NULL CONSTRAINT [DF_PortalUsers_FailedLoginAttempts] DEFAULT 0,
                    [LockedUntilUtc] datetime2 NULL,
                    [CreatedAtUtc] datetime2 NOT NULL CONSTRAINT [DF_PortalUsers_CreatedAtUtc] DEFAULT SYSUTCDATETIME(),
                    [LastLoginAtUtc] datetime2 NULL
                );
            END;
            IF OBJECT_ID(N'dbo.PortalRoles', N'U') IS NULL
            BEGIN
                CREATE TABLE [dbo].[PortalRoles] (
                    [Id] uniqueidentifier NOT NULL CONSTRAINT [PK_PortalRoles] PRIMARY KEY,
                    [Name] nvarchar(80) NOT NULL
                );
            END;
            IF OBJECT_ID(N'dbo.PortalUserRoles', N'U') IS NULL
            BEGIN
                CREATE TABLE [dbo].[PortalUserRoles] (
                    [UserId] uniqueidentifier NOT NULL,
                    [RoleId] uniqueidentifier NOT NULL,
                    CONSTRAINT [PK_PortalUserRoles] PRIMARY KEY ([UserId], [RoleId]),
                    CONSTRAINT [FK_PortalUserRoles_PortalUsers_UserId]
                        FOREIGN KEY ([UserId]) REFERENCES [dbo].[PortalUsers] ([Id]) ON DELETE CASCADE,
                    CONSTRAINT [FK_PortalUserRoles_PortalRoles_RoleId]
                        FOREIGN KEY ([RoleId]) REFERENCES [dbo].[PortalRoles] ([Id]) ON DELETE CASCADE
                );
            END;
            IF OBJECT_ID(N'dbo.PortalRolePermissions', N'U') IS NULL
            BEGIN
                CREATE TABLE [dbo].[PortalRolePermissions] (
                    [RoleId] uniqueidentifier NOT NULL,
                    [Permission] nvarchar(100) NOT NULL,
                    CONSTRAINT [PK_PortalRolePermissions] PRIMARY KEY ([RoleId], [Permission]),
                    CONSTRAINT [FK_PortalRolePermissions_PortalRoles_RoleId]
                        FOREIGN KEY ([RoleId]) REFERENCES [dbo].[PortalRoles] ([Id]) ON DELETE CASCADE
                );
            END;
            IF OBJECT_ID(N'dbo.InventoryMovements', N'U') IS NULL
            BEGIN
                CREATE TABLE [dbo].[InventoryMovements] (
                    [Id] uniqueidentifier NOT NULL CONSTRAINT [PK_InventoryMovements] PRIMARY KEY,
                    [ProductId] uniqueidentifier NOT NULL,
                    [MovementType] nvarchar(40) NOT NULL,
                    [QuantityChange] int NOT NULL,
                    [BalanceAfter] int NOT NULL,
                    [Reason] nvarchar(300) NOT NULL,
                    [Reference] nvarchar(120) NULL,
                    [CreatedByUserId] uniqueidentifier NULL,
                    [CreatedByEmail] nvarchar(254) NULL,
                    [CreatedAtUtc] datetime2 NOT NULL CONSTRAINT [DF_InventoryMovements_CreatedAtUtc] DEFAULT SYSUTCDATETIME(),
                    CONSTRAINT [FK_InventoryMovements_Products_ProductId]
                        FOREIGN KEY ([ProductId]) REFERENCES [dbo].[Products] ([Id])
                );
            END;
            IF OBJECT_ID(N'dbo.AuditEvents', N'U') IS NULL
            BEGIN
                CREATE TABLE [dbo].[AuditEvents] (
                    [Id] uniqueidentifier NOT NULL CONSTRAINT [PK_AuditEvents] PRIMARY KEY,
                    [UserId] uniqueidentifier NULL,
                    [UserEmail] nvarchar(254) NULL,
                    [Action] nvarchar(80) NOT NULL,
                    [EntityType] nvarchar(80) NOT NULL,
                    [EntityId] nvarchar(120) NULL,
                    [Details] nvarchar(2000) NULL,
                    [CreatedAtUtc] datetime2 NOT NULL CONSTRAINT [DF_AuditEvents_CreatedAtUtc] DEFAULT SYSUTCDATETIME()
                );
            END;
            IF OBJECT_ID(N'dbo.ProductBarcodeSequence', N'SO') IS NULL
                EXEC(N'CREATE SEQUENCE [dbo].[ProductBarcodeSequence] AS bigint START WITH 1000001 INCREMENT BY 1;');

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
            IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_PortalUsers_Email')
                CREATE UNIQUE INDEX [IX_PortalUsers_Email] ON [dbo].[PortalUsers] ([Email]);
            IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_PortalRoles_Name')
                CREATE UNIQUE INDEX [IX_PortalRoles_Name] ON [dbo].[PortalRoles] ([Name]);
            IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_InventoryMovements_CreatedAtUtc')
                CREATE INDEX [IX_InventoryMovements_CreatedAtUtc] ON [dbo].[InventoryMovements] ([CreatedAtUtc]);
            IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_InventoryMovements_ProductId_CreatedAtUtc')
                CREATE INDEX [IX_InventoryMovements_ProductId_CreatedAtUtc] ON [dbo].[InventoryMovements] ([ProductId], [CreatedAtUtc]);
            IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_AuditEvents_CreatedAtUtc')
                CREATE INDEX [IX_AuditEvents_CreatedAtUtc] ON [dbo].[AuditEvents] ([CreatedAtUtc]);
            """,
            cancellationToken);
    }
}
