using System.Security.Claims;
using System.Text;
using Microsoft.EntityFrameworkCore;
using SampleApi.Data;
using SampleApi.Models;

namespace SampleApi.Security;

public static class InventoryEndpoints
{
    public static void MapInventoryEndpoints(this WebApplication app)
    {
        var inventory = app.MapGroup("/api/inventory").RequireAuthorization(Permissions.InventoryRead);

        inventory.MapGet("/movements", async (
            ProductDbContext db,
            CancellationToken cancellationToken,
            Guid? productId,
            DateTime? fromUtc,
            DateTime? toUtc,
            string? movementType,
            int page = 1,
            int pageSize = 50) =>
        {
            var query = db.InventoryMovements.AsNoTracking().AsQueryable();
            if (productId.HasValue)
            {
                query = query.Where(item => item.ProductId == productId.Value);
            }

            if (fromUtc.HasValue)
            {
                query = query.Where(item => item.CreatedAtUtc >= fromUtc.Value);
            }

            if (toUtc.HasValue)
            {
                query = query.Where(item => item.CreatedAtUtc < toUtc.Value);
            }

            if (!string.IsNullOrWhiteSpace(movementType))
            {
                query = query.Where(item => item.MovementType == movementType.Trim());
            }

            var totalCount = await query.CountAsync(cancellationToken);
            pageSize = Math.Clamp(pageSize, 1, 200);
            var pageCount = Math.Max(1, (int)Math.Ceiling(totalCount / (double)pageSize));
            page = Math.Clamp(page, 1, pageCount);
            var items = await query.OrderByDescending(item => item.CreatedAtUtc)
                .Skip((page - 1) * pageSize).Take(pageSize)
                .Select(item => new InventoryMovementResponse(
                    item.Id, item.ProductId, item.Product.Name, item.Product.Sku,
                    item.MovementType, item.QuantityChange, item.BalanceAfter,
                    item.Reason, item.Reference, item.CreatedByEmail, item.CreatedAtUtc))
                .ToListAsync(cancellationToken);
            return Results.Ok(new { items, totalCount, page, pageSize });
        });

        inventory.MapPost("/adjustments", async (
            InventoryAdjustmentRequest request,
            ProductDbContext db,
            ClaimsPrincipal actor,
            CancellationToken cancellationToken) =>
        {
            if (request.QuantityChange == 0 || string.IsNullOrWhiteSpace(request.Reason)
                || request.Reason.Trim().Length > 300 || request.Reference is { Length: > 120 })
            {
                return Results.ValidationProblem(new Dictionary<string, string[]>
                {
                    ["adjustment"] = ["Enter a non-zero quantity change, a reason of at most 300 characters, and an optional reference of at most 120 characters."]
                });
            }

            await using var transaction = await db.Database.BeginTransactionAsync(cancellationToken);
            var product = await db.Products.SingleOrDefaultAsync(
                item => item.Id == request.ProductId && item.IsActive,
                cancellationToken);
            if (product is null)
            {
                return Results.NotFound(new { message = "Product not found." });
            }

            var updatedStock = (long)product.Stock + request.QuantityChange;
            if (updatedStock is < 0 or > int.MaxValue)
            {
                return Results.BadRequest(new { message = "The adjustment would result in an invalid stock balance." });
            }

            product.Stock = (int)updatedStock;
            var movement = new InventoryMovement
            {
                Id = Guid.NewGuid(),
                ProductId = product.Id,
                MovementType = "Adjustment",
                QuantityChange = request.QuantityChange,
                BalanceAfter = product.Stock,
                Reason = request.Reason.Trim(),
                Reference = NormalizeOptional(request.Reference),
                CreatedByUserId = ReadUserId(actor),
                CreatedByEmail = actor.FindFirstValue(ClaimTypes.Email),
                CreatedAtUtc = DateTime.UtcNow
            };
            db.InventoryMovements.Add(movement);
            await db.SaveChangesAsync(cancellationToken);
            await AuditLog.RecordAsync(db, actor, "Inventory adjusted", "Product", product.Id.ToString(),
                new { movement.QuantityChange, movement.BalanceAfter, movement.Reason, movement.Reference },
                cancellationToken);
            await transaction.CommitAsync(cancellationToken);
            return Results.Ok(new { productId = product.Id, product.Name, product.Stock, movement.Id });
        }).RequireAuthorization(Permissions.InventoryAdjust);

        inventory.MapGet("/barcode/{productId:guid}", async (
            Guid productId,
            ProductDbContext db,
            CancellationToken cancellationToken) =>
        {
            var product = await db.Products.AsNoTracking()
                .Where(item => item.Id == productId)
                .Select(item => new { item.Barcode, item.Name, item.Sku })
                .SingleOrDefaultAsync(cancellationToken);
            if (product is null)
            {
                return Results.NotFound();
            }

            var escapedName = System.Security.SecurityElement.Escape(product.Name) ?? string.Empty;
            var escapedSku = System.Security.SecurityElement.Escape(product.Sku ?? string.Empty) ?? string.Empty;
            var escapedBarcode = System.Security.SecurityElement.Escape(product.Barcode ?? string.Empty) ?? string.Empty;
            return Results.Ok(new { format = "CODE128", value = escapedBarcode, product = escapedName, sku = escapedSku });
        });

        var reports = app.MapGroup("/api/reports").RequireAuthorization(Permissions.ReportsRead);
        reports.MapGet("/dashboard", async (ProductDbContext db, CancellationToken cancellationToken) =>
        {
            var productStats = await db.Products.AsNoTracking()
                .Where(product => product.IsActive)
                .GroupBy(_ => 1)
                .Select(group => new
                {
                    ProductCount = group.Count(),
                    UnitsOnHand = group.Sum(product => (long)product.Stock),
                    InventoryRetailValue = group.Sum(product => product.Price * product.Stock),
                    LowStockCount = group.Count(product => product.Stock > 0 && product.Stock <= product.ReorderLevel),
                    OutOfStockCount = group.Count(product => product.Stock == 0)
                })
                .SingleOrDefaultAsync(cancellationToken);

            var lowStock = await db.Products.AsNoTracking()
                .Where(product => product.IsActive && product.Stock <= product.ReorderLevel)
                .OrderBy(product => product.Stock)
                .ThenBy(product => product.Name)
                .Take(10)
                .Select(product => new
                {
                    product.Id, product.Name, product.Sku, product.Stock,
                    product.ReorderLevel, product.Price
                })
                .ToListAsync(cancellationToken);

            var from = DateTime.UtcNow.Date.AddDays(-13);
            var movementTrend = await db.InventoryMovements.AsNoTracking()
                .Where(movement => movement.CreatedAtUtc >= from)
                .GroupBy(movement => movement.CreatedAtUtc.Date)
                .Select(group => new
                {
                    Date = group.Key,
                    Received = group.Where(item => item.QuantityChange > 0).Sum(item => (long)item.QuantityChange),
                    Issued = group.Where(item => item.QuantityChange < 0).Sum(item => -(long)item.QuantityChange),
                    Transactions = group.Count()
                })
                .ToListAsync(cancellationToken);

            var recentMovements = await db.InventoryMovements.AsNoTracking()
                .OrderByDescending(item => item.CreatedAtUtc)
                .Take(8)
                .Select(item => new InventoryMovementResponse(
                    item.Id, item.ProductId, item.Product.Name, item.Product.Sku,
                    item.MovementType, item.QuantityChange, item.BalanceAfter,
                    item.Reason, item.Reference, item.CreatedByEmail, item.CreatedAtUtc))
                .ToListAsync(cancellationToken);

            var dates = Enumerable.Range(0, 14)
                .Select(offset => from.AddDays(offset))
                .ToArray();
            var trend = dates.Select(date =>
            {
                var day = movementTrend.FirstOrDefault(item => item.Date == date);
                return new
                {
                    date,
                    received = day?.Received ?? 0,
                    issued = day?.Issued ?? 0,
                    transactions = day?.Transactions ?? 0
                };
            }).ToArray();

            return Results.Ok(new
            {
                productCount = productStats?.ProductCount ?? 0,
                unitsOnHand = productStats?.UnitsOnHand ?? 0,
                inventoryRetailValue = productStats?.InventoryRetailValue ?? 0,
                lowStockCount = productStats?.LowStockCount ?? 0,
                outOfStockCount = productStats?.OutOfStockCount ?? 0,
                lowStock,
                movementTrend = trend,
                recentMovements
            });
        });

        reports.MapGet("/inventory.csv", async (ProductDbContext db, CancellationToken cancellationToken) =>
        {
            var products = await db.Products.AsNoTracking().Where(item => item.IsActive).OrderBy(item => item.Name)
                .Select(item => new
                {
                    item.Name, item.Sku, item.Barcode, item.Category, item.Brand,
                    item.Stock, item.ReorderLevel, item.Price
                }).ToListAsync(cancellationToken);
            var csv = new StringBuilder("Name,SKU,Barcode,Category,Brand,On hand,Reorder level,Unit price,Retail value\r\n");
            foreach (var product in products)
            {
                csv.AppendLine(string.Join(',', new[]
                {
                    Csv(product.Name), Csv(product.Sku), Csv(product.Barcode), Csv(product.Category),
                    Csv(product.Brand), product.Stock.ToString(), product.ReorderLevel.ToString(),
                    product.Price.ToString("0.00", System.Globalization.CultureInfo.InvariantCulture),
                    (product.Price * product.Stock).ToString("0.00", System.Globalization.CultureInfo.InvariantCulture)
                }));
            }

            return Results.File(Encoding.UTF8.GetBytes(csv.ToString()), "text/csv", "inventory-report.csv");
        });

        reports.MapGet("/movements.csv", async (
            ProductDbContext db,
            CancellationToken cancellationToken,
            DateTime? fromUtc,
            DateTime? toUtc) =>
        {
            var query = db.InventoryMovements.AsNoTracking().AsQueryable();
            if (fromUtc.HasValue) query = query.Where(item => item.CreatedAtUtc >= fromUtc.Value);
            if (toUtc.HasValue) query = query.Where(item => item.CreatedAtUtc < toUtc.Value);
            var movements = await query.OrderByDescending(item => item.CreatedAtUtc)
                .Select(item => new
                {
                    item.CreatedAtUtc, item.MovementType, item.Product.Name, item.Product.Sku,
                    item.QuantityChange, item.BalanceAfter, item.Reason, item.Reference, item.CreatedByEmail
                }).ToListAsync(cancellationToken);
            var csv = new StringBuilder("Date UTC,Type,Product,SKU,Quantity change,Balance after,Reason,Reference,User\r\n");
            foreach (var item in movements)
            {
                csv.AppendLine(string.Join(',', new[]
                {
                    Csv(item.CreatedAtUtc.ToString("O")), Csv(item.MovementType), Csv(item.Name), Csv(item.Sku),
                    item.QuantityChange.ToString(), item.BalanceAfter.ToString(), Csv(item.Reason),
                    Csv(item.Reference), Csv(item.CreatedByEmail)
                }));
            }

            return Results.File(Encoding.UTF8.GetBytes(csv.ToString()), "text/csv", "inventory-movements.csv");
        });

        var audit = app.MapGroup("/api/audit").RequireAuthorization(Permissions.AuditRead);
        audit.MapGet("/", async (ProductDbContext db, CancellationToken cancellationToken, int page = 1, int pageSize = 50) =>
        {
            pageSize = Math.Clamp(pageSize, 1, 200);
            var totalCount = await db.AuditEvents.CountAsync(cancellationToken);
            var pageCount = Math.Max(1, (int)Math.Ceiling(totalCount / (double)pageSize));
            page = Math.Clamp(page, 1, pageCount);
            var items = await db.AuditEvents.AsNoTracking()
                .OrderByDescending(item => item.CreatedAtUtc)
                .Skip((page - 1) * pageSize).Take(pageSize)
                .Select(item => new
                {
                    item.Id, item.UserEmail, item.Action, item.EntityType,
                    item.EntityId, item.Details, item.CreatedAtUtc
                }).ToListAsync(cancellationToken);
            return Results.Ok(new { items, totalCount, page, pageSize });
        });
    }

    private static Guid? ReadUserId(ClaimsPrincipal actor) =>
        Guid.TryParse(actor.FindFirstValue(ClaimTypes.NameIdentifier), out var id) ? id : null;

    private static string? NormalizeOptional(string? value) =>
        string.IsNullOrWhiteSpace(value) ? null : value.Trim();

    private static string Csv(string? value)
    {
        var safe = value ?? string.Empty;
        if (safe.Length > 0 && safe[0] is '=' or '+' or '-' or '@' or '\t' or '\r')
        {
            safe = "'" + safe;
        }

        return $"\"{safe.Replace("\"", "\"\"")}\"";
    }
}
