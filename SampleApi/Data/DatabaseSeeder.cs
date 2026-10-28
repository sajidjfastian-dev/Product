using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using SampleApi.Models;

namespace SampleApi.Data;

public static class DatabaseSeeder
{
    private const string SeedMarker = "InitialProductsV1";

    public static async Task SeedAsync(
        ProductDbContext db,
        string seedFile,
        CancellationToken cancellationToken = default)
    {
        if (await db.SeedStates.AnyAsync(state => state.Key == SeedMarker, cancellationToken))
        {
            return;
        }

        var json = await File.ReadAllTextAsync(seedFile, cancellationToken);
        var products = JsonSerializer.Deserialize<List<Product>>(json, new JsonSerializerOptions
        {
            PropertyNameCaseInsensitive = true
        });

        if (products is null || products.Count == 0)
        {
            throw new InvalidDataException($"Product seed file '{seedFile}' is empty or invalid.");
        }

        db.Products.AddRange(products);
        db.SeedStates.Add(new DatabaseSeedState { Key = SeedMarker });
        await db.SaveChangesAsync(cancellationToken);
    }
}
