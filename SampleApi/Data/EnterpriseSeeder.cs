using Microsoft.EntityFrameworkCore;
using SampleApi.Models;
using SampleApi.Security;

namespace SampleApi.Data;

public static class EnterpriseSeeder
{
    private const string OpeningBalanceSeedMarker = "InitialInventoryMovementsV1";

    public static async Task SeedOpeningBalancesAsync(
        ProductDbContext db,
        CancellationToken cancellationToken)
    {
        if (await db.SeedStates.AnyAsync(state => state.Key == OpeningBalanceSeedMarker, cancellationToken))
        {
            return;
        }

        var products = await db.Products.AsNoTracking().ToListAsync(cancellationToken);
        var movements = products
            .Where(product => product.Stock > 0)
            .Select(product => new InventoryMovement
            {
                Id = Guid.NewGuid(),
                ProductId = product.Id,
                MovementType = "Opening balance",
                QuantityChange = product.Stock,
                BalanceAfter = product.Stock,
                Reason = "Opening inventory balance",
                CreatedAtUtc = DateTime.UtcNow
            })
            .ToArray();

        db.InventoryMovements.AddRange(movements);
        db.SeedStates.Add(new DatabaseSeedState { Key = OpeningBalanceSeedMarker });
        await db.SaveChangesAsync(cancellationToken);
    }

    public static async Task AssignMissingBarcodesAsync(
        ProductDbContext db,
        CancellationToken cancellationToken)
    {
        var products = await db.Products
            .Where(product => product.Barcode == null || product.Barcode == "")
            .OrderBy(product => product.Name)
            .ToListAsync(cancellationToken);

        foreach (var product in products)
        {
            product.Barcode = await BarcodeService.NextAsync(db, cancellationToken);
        }

        if (products.Count > 0)
        {
            await db.SaveChangesAsync(cancellationToken);
        }
    }
}

public static class BarcodeService
{
    public static async Task<string> NextAsync(
        ProductDbContext db,
        CancellationToken cancellationToken)
    {
        await db.Database.OpenConnectionAsync(cancellationToken);
        long value;
        try
        {
            await using var command = db.Database.GetDbConnection().CreateCommand();
            command.CommandText = "SELECT NEXT VALUE FOR dbo.ProductBarcodeSequence";
            value = Convert.ToInt64(
                await command.ExecuteScalarAsync(cancellationToken),
                System.Globalization.CultureInfo.InvariantCulture);
        }
        finally
        {
            await db.Database.CloseConnectionAsync();
        }

        return $"INV{value:D10}";
    }
}
