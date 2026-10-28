using System.Text.Json;
using System.Security;
using Microsoft.EntityFrameworkCore;
using SampleApi.Models;

namespace SampleApi.Data;

public static class DatabaseSeeder
{
    private const string SeedMarker = "InitialProductsV1";
    private const string AdditionalSamplesSeedMarker = "AdditionalSampleProductsV1";
    private const string SampleIllustrationsSeedMarker = "SampleProductIllustrationsV1";
    private static readonly string[] IllustrationPalettes =
    [
        "#dce9ff", "#d9f0e7", "#ffeadb", "#ece2ff", "#fff0c9",
        "#d8eff5", "#f7deeb", "#e7ebd8", "#f9e1d8", "#e0e5f7"
    ];

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

    public static async Task SeedAdditionalSamplesAsync(
        ProductDbContext db,
        string seedFile,
        CancellationToken cancellationToken = default)
    {
        if (await db.SeedStates.AnyAsync(state => state.Key == AdditionalSamplesSeedMarker, cancellationToken))
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

        if (products.Any(product =>
                product.Id == Guid.Empty
                || string.IsNullOrWhiteSpace(product.Name)
                || string.IsNullOrWhiteSpace(product.Category))
            || products.Select(product => product.Id).Distinct().Count() != products.Count
            || products.Where(product => !string.IsNullOrWhiteSpace(product.Sku))
                .Select(product => product.Sku)
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .Count() != products.Count(product => !string.IsNullOrWhiteSpace(product.Sku))
            || products.Where(product => !string.IsNullOrWhiteSpace(product.Barcode))
                .Select(product => product.Barcode)
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .Count() != products.Count(product => !string.IsNullOrWhiteSpace(product.Barcode)))
        {
            throw new InvalidDataException($"Product seed file '{seedFile}' contains invalid or duplicate products.");
        }

        var ids = products.Select(product => product.Id).ToArray();
        var skus = products.Where(product => product.Sku is not null).Select(product => product.Sku!).ToArray();
        var barcodes = products.Where(product => product.Barcode is not null).Select(product => product.Barcode!).ToArray();
        var conflicts = await db.Products.AsNoTracking()
            .Where(product =>
                ids.Contains(product.Id)
                || (product.Sku != null && skus.Contains(product.Sku))
                || (product.Barcode != null && barcodes.Contains(product.Barcode)))
            .Select(product => product.Id)
            .ToListAsync(cancellationToken);

        if (conflicts.Count > 0)
        {
            throw new InvalidOperationException(
                $"Cannot add sample products because {conflicts.Count} product identifier(s) already exist in the catalog.");
        }

        db.Products.AddRange(products);
        db.SeedStates.Add(new DatabaseSeedState { Key = AdditionalSamplesSeedMarker });
        await db.SaveChangesAsync(cancellationToken);
    }

    public static async Task SeedSampleIllustrationsAsync(
        ProductDbContext db,
        CancellationToken cancellationToken = default)
    {
        if (await db.SeedStates.AnyAsync(state => state.Key == SampleIllustrationsSeedMarker, cancellationToken))
        {
            return;
        }

        var products = await db.Products
            .Include(product => product.Images)
            .ToListAsync(cancellationToken);
        var productsWithoutImages = products.Where(product => product.Images.Count == 0).ToArray();
        var illustrations = new List<ProductImage>(productsWithoutImages.Length);

        foreach (var product in productsWithoutImages)
        {
            var svg = CreateSampleIllustration(product);
            var data = System.Text.Encoding.UTF8.GetBytes(svg);
            illustrations.Add(new ProductImage
            {
                Id = Guid.NewGuid(),
                ProductId = product.Id,
                FileName = $"{product.Sku ?? product.Id.ToString("N")}-sample.svg",
                ContentType = "image/svg+xml",
                ContentLength = data.Length,
                Data = data,
                SortOrder = 0,
                CreatedAtUtc = DateTime.UtcNow
            });
        }

        db.ProductImages.AddRange(illustrations);
        db.SeedStates.Add(new DatabaseSeedState { Key = SampleIllustrationsSeedMarker });
        await db.SaveChangesAsync(cancellationToken);
    }

    private static string CreateSampleIllustration(Product product)
    {
        var escapedName = SecurityElement.Escape(product.Name) ?? string.Empty;
        var escapedCategory = SecurityElement.Escape(product.Category) ?? string.Empty;
        var escapedSku = SecurityElement.Escape(product.Sku ?? "SAMPLE PRODUCT") ?? string.Empty;
        var paletteIndex = (int)((uint)StringComparer.Ordinal.GetHashCode(product.Sku ?? product.Name)
            % (uint)IllustrationPalettes.Length);
        var accent = IllustrationPalettes[paletteIndex];
        var icon = product.Category switch
        {
            "Displays" => """
                <rect x="236" y="106" width="168" height="111" rx="12" fill="#26354a"/>
                <rect x="246" y="116" width="148" height="91" rx="5" fill="#a9d8e8"/>
                <path d="M288 231h64l12 30h-88z" fill="#52657d"/>
                <rect x="272" y="260" width="96" height="10" rx="5" fill="#26354a"/>
                """,
            "Audio" => """
                <path d="M235 215v-28a85 85 0 0 1 170 0v28" fill="none" stroke="#26354a" stroke-width="24" stroke-linecap="round"/>
                <rect x="218" y="194" width="42" height="80" rx="18" fill="#52657d"/>
                <rect x="380" y="194" width="42" height="80" rx="18" fill="#52657d"/>
                <path d="M260 230q60 65 120 0" fill="none" stroke="#7890a8" stroke-width="8" stroke-linecap="round"/>
                """,
            "Cameras" => """
                <rect x="224" y="146" width="192" height="119" rx="24" fill="#26354a"/>
                <path d="m268 146 16-23h72l16 23" fill="#52657d"/>
                <circle cx="320" cy="204" r="48" fill="#91a8bc"/>
                <circle cx="320" cy="204" r="34" fill="#26354a"/>
                <circle cx="320" cy="204" r="20" fill="#8bd3df"/>
                """,
            "Networking" => """
                <rect x="235" y="204" width="170" height="60" rx="18" fill="#26354a"/>
                <path d="M270 180a72 72 0 0 1 100 0M287 195a47 47 0 0 1 66 0M305 210a21 21 0 0 1 30 0" fill="none" stroke="#52657d" stroke-width="10" stroke-linecap="round"/>
                <circle cx="270" cy="237" r="5" fill="#b9eed1"/><circle cx="290" cy="237" r="5" fill="#b9eed1"/>
                """,
            "Storage" => """
                <rect x="249" y="130" width="142" height="142" rx="24" fill="#26354a"/>
                <rect x="265" y="146" width="110" height="110" rx="16" fill="#52657d"/>
                <path d="M285 221h70M285 204h70M285 187h44" stroke="#c4d5e4" stroke-width="8" stroke-linecap="round"/>
                <circle cx="352" cy="166" r="6" fill="#b9eed1"/>
                """,
            "Cables" => """
                <path d="M248 154c0 100 144 48 144 145" fill="none" stroke="#26354a" stroke-width="24" stroke-linecap="round"/>
                <path d="M248 154c0 100 144 48 144 145" fill="none" stroke="#52657d" stroke-width="12" stroke-linecap="round"/>
                <rect x="230" y="126" width="36" height="40" rx="8" fill="#26354a"/>
                <rect x="374" y="282" width="36" height="40" rx="8" fill="#26354a"/>
                """,
            "Components" => """
                <rect x="250" y="135" width="140" height="140" rx="18" fill="#26354a"/>
                <rect x="270" y="155" width="100" height="100" rx="10" fill="#52657d"/>
                <rect x="292" y="177" width="56" height="56" rx="8" fill="#b9eed1"/>
                <path d="M270 125v10m30-10v10m30-10v10m30-10v10m30-10v10M270 275v10m30-10v10m30-10v10m30-10v10m30-10v10M240 155h10m-10 30h10m-10 30h10m-10 30h10m140-90h10m-10 30h10m-10 30h10m-10 30h10" stroke="#26354a" stroke-width="6"/>
                """,
            "Office" => """
                <rect x="245" y="133" width="150" height="139" rx="18" fill="#26354a"/>
                <rect x="263" y="152" width="114" height="62" rx="8" fill="#c6d9e8"/>
                <path d="M276 234h88m-75 14h62" stroke="#8296aa" stroke-width="8" stroke-linecap="round"/>
                <rect x="278" y="116" width="84" height="14" rx="5" fill="#52657d"/>
                """,
            _ => """
                <rect x="250" y="142" width="140" height="110" rx="28" fill="#26354a"/>
                <rect x="266" y="158" width="108" height="78" rx="18" fill="#52657d"/>
                <circle cx="320" cy="197" r="22" fill="#b9eed1"/>
                <path d="M278 265h84" stroke="#26354a" stroke-width="12" stroke-linecap="round"/>
                """
        };

        return $$"""
            <svg xmlns="http://www.w3.org/2000/svg" width="640" height="480" viewBox="0 0 640 480">
              <defs>
                <linearGradient id="background" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0" stop-color="{{accent}}"/>
                  <stop offset="1" stop-color="#f8fafc"/>
                </linearGradient>
              </defs>
              <rect width="640" height="480" rx="32" fill="url(#background)"/>
              <circle cx="530" cy="112" r="80" fill="#ffffff" opacity=".34"/>
              <circle cx="101" cy="367" r="112" fill="#ffffff" opacity=".25"/>
              <rect x="34" y="31" width="572" height="418" rx="27" fill="#ffffff" opacity=".64"/>
              <rect x="48" y="45" width="544" height="390" rx="21" fill="none" stroke="#ffffff" stroke-width="2"/>
              <text x="74" y="88" fill="#586b7d" font-family="Arial,sans-serif" font-size="17" font-weight="700" letter-spacing="2">{{escapedCategory.ToUpperInvariant()}}</text>
              <g>{{icon}}</g>
              <text x="74" y="337" fill="#1d2938" font-family="Arial,sans-serif" font-size="26" font-weight="700">{{escapedName}}</text>
              <text x="74" y="370" fill="#627184" font-family="Arial,sans-serif" font-size="15">{{escapedSku}}</text>
              <rect x="74" y="393" width="78" height="5" rx="2.5" fill="#52657d"/>
              <text x="566" y="402" text-anchor="end" fill="#627184" font-family="Arial,sans-serif" font-size="14">SAMPLE IMAGE</text>
            </svg>
            """;
    }
}
