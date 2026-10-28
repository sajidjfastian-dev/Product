using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using SampleApi.Data;
using SampleApi.Models;

const int maxImagesPerProduct = 8;
const int maxImageSizeBytes = 8 * 1024 * 1024;
const int maxGalleryRequestBytes = maxImagesPerProduct * maxImageSizeBytes + 1024 * 1024;

var builder = WebApplication.CreateBuilder(args);

var connectionString = builder.Configuration.GetConnectionString("Products")
    ?? throw new InvalidOperationException("Connection string 'Products' is required.");

builder.Services.AddDbContext<ProductDbContext>(options =>
    options.UseSqlServer(connectionString, sql => sql.EnableRetryOnFailure()));

builder.Services.Configure<FormOptions>(options =>
    options.MultipartBodyLengthLimit = maxGalleryRequestBytes);

builder.Services.AddCors(options =>
    options.AddDefaultPolicy(policy =>
        policy.WithOrigins(builder.Configuration["Frontend:Origin"] ?? "http://localhost:8081")
            .AllowAnyHeader()
            .AllowAnyMethod()));

var app = builder.Build();

app.UseCors();

await using (var scope = app.Services.CreateAsyncScope())
{
    var db = scope.ServiceProvider.GetRequiredService<ProductDbContext>();
    await db.Database.EnsureCreatedAsync();
    await ProductDbSchema.EnsureExtendedSchemaAsync(db);

    var seedFile = Path.Combine(AppContext.BaseDirectory, "test-data", "products.json");
    await DatabaseSeeder.SeedAsync(db, seedFile);
    var sampleProductsFile = Path.Combine(AppContext.BaseDirectory, "test-data", "additional-sample-products.json");
    await DatabaseSeeder.SeedAdditionalSamplesAsync(db, sampleProductsFile);
    await DatabaseSeeder.SeedSampleIllustrationsAsync(db);
}

app.MapGet("/health", () => Results.Ok(new { status = "Healthy" }));

var products = app.MapGroup("/api/products");

products.MapGet("/", async (
    string? search,
    string? category,
    string? location,
    string? brand,
    string? stock,
    decimal? minPrice,
    decimal? maxPrice,
    string? sortBy,
    string? sortDirection,
    ProductDbContext db,
    CancellationToken cancellationToken,
    int page = 1,
    int pageSize = 20) =>
{
    var query = db.Products.AsNoTracking().AsQueryable();

    if (!string.IsNullOrWhiteSpace(search))
    {
        var term = search.Trim();
        query = query.Where(product =>
            product.Name.Contains(term)
            || (product.Sku != null && product.Sku.Contains(term))
            || (product.Barcode != null && product.Barcode.Contains(term))
            || (product.Category != null && product.Category.Contains(term))
            || (product.Brand != null && product.Brand.Contains(term))
            || (product.Location != null && product.Location.Contains(term)));
    }

    if (!string.IsNullOrWhiteSpace(category))
    {
        query = query.Where(product => product.Category == category.Trim());
    }

    if (!string.IsNullOrWhiteSpace(location))
    {
        query = query.Where(product => product.Location != null && product.Location.Contains(location.Trim()));
    }

    if (!string.IsNullOrWhiteSpace(brand))
    {
        query = query.Where(product => product.Brand == brand.Trim());
    }

    if (string.Equals(stock, "in", StringComparison.OrdinalIgnoreCase))
    {
        query = query.Where(product => product.Stock > 0);
    }
    else if (string.Equals(stock, "out", StringComparison.OrdinalIgnoreCase))
    {
        query = query.Where(product => product.Stock == 0);
    }

    if (minPrice.HasValue)
    {
        query = query.Where(product => product.Price >= minPrice.Value);
    }

    if (maxPrice.HasValue)
    {
        query = query.Where(product => product.Price <= maxPrice.Value);
    }

    var totalCount = await query.CountAsync(cancellationToken);
    pageSize = Math.Clamp(pageSize, 1, 100);
    var pageCount = Math.Max(1, (int)Math.Ceiling(totalCount / (double)pageSize));
    page = Math.Clamp(page, 1, pageCount);
    var descending = string.Equals(sortDirection, "desc", StringComparison.OrdinalIgnoreCase);

    query = (sortBy?.ToLowerInvariant(), descending) switch
    {
        ("category", false) => query.OrderBy(product => product.Category).ThenBy(product => product.Name),
        ("category", true) => query.OrderByDescending(product => product.Category).ThenBy(product => product.Name),
        ("sku", false) => query.OrderBy(product => product.Sku).ThenBy(product => product.Name),
        ("sku", true) => query.OrderByDescending(product => product.Sku).ThenBy(product => product.Name),
        ("barcode", false) => query.OrderBy(product => product.Barcode).ThenBy(product => product.Name),
        ("barcode", true) => query.OrderByDescending(product => product.Barcode).ThenBy(product => product.Name),
        ("brand", false) => query.OrderBy(product => product.Brand).ThenBy(product => product.Name),
        ("brand", true) => query.OrderByDescending(product => product.Brand).ThenBy(product => product.Name),
        ("location", false) => query.OrderBy(product => product.Location).ThenBy(product => product.Name),
        ("location", true) => query.OrderByDescending(product => product.Location).ThenBy(product => product.Name),
        ("price", false) => query.OrderBy(product => product.Price).ThenBy(product => product.Name),
        ("price", true) => query.OrderByDescending(product => product.Price).ThenBy(product => product.Name),
        ("stock", false) => query.OrderBy(product => product.Stock).ThenBy(product => product.Name),
        ("stock", true) => query.OrderByDescending(product => product.Stock).ThenBy(product => product.Name),
        (_, false) => query.OrderBy(product => product.Name),
        _ => query.OrderByDescending(product => product.Name)
    };

    var items = await query
        .Skip((page - 1) * pageSize)
        .Take(pageSize)
        .Select(product => new ProductResponse(
            product.Id,
            product.Name,
            product.Category,
            product.Price,
            product.Stock,
            product.Barcode,
            product.Sku,
            product.Description,
            product.Location,
            product.Brand,
            product.CreatedAtUtc,
            product.Images
                .OrderBy(image => image.SortOrder)
                .Select(image => new ProductImageResponse(
                    image.Id,
                    image.FileName,
                    image.ContentType,
                    image.SortOrder))
                .ToList()))
        .ToListAsync(cancellationToken);

    return Results.Ok(new ProductListResponse(items, totalCount, page, pageSize));
});

products.MapGet("/pdf", async (ProductDbContext db, CancellationToken cancellationToken) =>
{
    var items = await db.Products.AsNoTracking()
        .OrderBy(product => product.Name)
        .ToListAsync(cancellationToken);

    var pdf = ProductPdf.Generate(items);
    return Results.File(pdf, "application/pdf", "products.pdf");
});

products.MapPost("/", async (
    ProductRequest request,
    ProductDbContext db,
    CancellationToken cancellationToken) =>
{
    var errors = Validate(request);
    if (errors.Count > 0)
    {
        return Results.ValidationProblem(errors);
    }

    var uniqueFieldConflict = await FindUniqueFieldConflictAsync(request, null, db, cancellationToken);
    if (uniqueFieldConflict is not null)
    {
        return Results.Conflict(new { message = uniqueFieldConflict });
    }

    var product = new Product
    {
        Id = Guid.NewGuid(),
        Name = request.Name.Trim(),
        Category = request.Category.Trim(),
        Price = request.Price,
        Stock = request.Stock,
        Barcode = NormalizeOptional(request.Barcode),
        Sku = NormalizeOptional(request.Sku),
        Description = NormalizeOptional(request.Description),
        Location = NormalizeOptional(request.Location),
        Brand = NormalizeOptional(request.Brand),
        CreatedAtUtc = DateTime.UtcNow
    };

    db.Products.Add(product);
    await db.SaveChangesAsync(cancellationToken);
    return Results.Created($"/api/products/{product.Id}", ToResponse(product));
});

products.MapPut("/{id:guid}", async (
    Guid id,
    ProductRequest request,
    ProductDbContext db,
    CancellationToken cancellationToken) =>
{
    var errors = Validate(request);
    if (errors.Count > 0)
    {
        return Results.ValidationProblem(errors);
    }

    var product = await db.Products.FindAsync([id], cancellationToken);
    if (product is null)
    {
        return Results.NotFound();
    }

    var uniqueFieldConflict = await FindUniqueFieldConflictAsync(request, id, db, cancellationToken);
    if (uniqueFieldConflict is not null)
    {
        return Results.Conflict(new { message = uniqueFieldConflict });
    }

    product.Name = request.Name.Trim();
    product.Category = request.Category.Trim();
    product.Price = request.Price;
    product.Stock = request.Stock;
    product.Barcode = NormalizeOptional(request.Barcode);
    product.Sku = NormalizeOptional(request.Sku);
    product.Description = NormalizeOptional(request.Description);
    product.Location = NormalizeOptional(request.Location);
    product.Brand = NormalizeOptional(request.Brand);

    await db.SaveChangesAsync(cancellationToken);
    return Results.Ok(ToResponse(product));
});

products.MapPost("/{id:guid}/images", async (
    Guid id,
    [FromForm] IFormFileCollection? files,
    ProductDbContext db,
    CancellationToken cancellationToken) =>
{
    if (files is null || files.Count == 0)
    {
        return Results.BadRequest(new { message = "Select at least one image." });
    }

    if (files.Count > maxImagesPerProduct)
    {
        return Results.BadRequest(new { message = $"Upload at most {maxImagesPerProduct} images at a time." });
    }

    var product = await db.Products.FindAsync([id], cancellationToken);
    if (product is null)
    {
        return Results.NotFound();
    }

    var currentImageCount = await db.ProductImages.CountAsync(
        image => image.ProductId == id,
        cancellationToken);
    if (currentImageCount + files.Count > maxImagesPerProduct)
    {
        return Results.BadRequest(new
        {
            message = $"A product can have at most {maxImagesPerProduct} images. Remove an image before adding more."
        });
    }

    if (files.Any(file => file.Length is <= 0 or > maxImageSizeBytes))
    {
        return Results.BadRequest(new { message = "Each image must be larger than 0 and no larger than 8 MB." });
    }

    var nextSortOrder = currentImageCount;
    var images = new List<ProductImage>();
    foreach (var file in files)
    {
        await using var memory = new MemoryStream((int)file.Length);
        await file.CopyToAsync(memory, cancellationToken);
        var data = memory.ToArray();
        var contentType = DetectImageContentType(data);
        if (contentType is null)
        {
            return Results.BadRequest(new { message = "Only valid JPEG, PNG, and WebP image files are supported." });
        }

        var fileName = Path.GetFileName(file.FileName.Replace('\\', '/'));
        if (string.IsNullOrWhiteSpace(fileName))
        {
            fileName = "product-image";
        }

        if (fileName.Length > 255)
        {
            fileName = fileName[^255..];
        }

        images.Add(new ProductImage
        {
            Id = Guid.NewGuid(),
            ProductId = id,
            FileName = fileName,
            ContentType = contentType,
            ContentLength = data.Length,
            Data = data,
            SortOrder = nextSortOrder++,
            CreatedAtUtc = DateTime.UtcNow
        });
    }

    db.ProductImages.AddRange(images);
    await db.SaveChangesAsync(cancellationToken);
    return Results.Ok(new ProductImageUploadResponse(images
        .Select(ToImageResponse)
        .ToArray()));
})
.DisableAntiforgery()
.WithMetadata(
    new RequestSizeLimitAttribute(maxGalleryRequestBytes),
    new RequestFormLimitsAttribute { MultipartBodyLengthLimit = maxGalleryRequestBytes });

products.MapGet("/{id:guid}/images/{imageId:guid}", async (
    Guid id,
    Guid imageId,
    ProductDbContext db,
    CancellationToken cancellationToken) =>
{
    var image = await db.ProductImages.AsNoTracking()
        .Where(item => item.ProductId == id && item.Id == imageId)
        .Select(item => new { item.Data, item.ContentType, item.FileName })
        .FirstOrDefaultAsync(cancellationToken);

    return image is null
        ? Results.NotFound()
        : Results.File(image.Data, image.ContentType, enableRangeProcessing: true);
});

products.MapDelete("/{id:guid}/images/{imageId:guid}", async (
    Guid id,
    Guid imageId,
    ProductDbContext db,
    CancellationToken cancellationToken) =>
{
    var image = await db.ProductImages.FirstOrDefaultAsync(
        item => item.ProductId == id && item.Id == imageId,
        cancellationToken);
    if (image is null)
    {
        return Results.NotFound();
    }

    db.ProductImages.Remove(image);
    await db.SaveChangesAsync(cancellationToken);
    return Results.NoContent();
});

products.MapDelete("/{id:guid}", async (
    Guid id,
    ProductDbContext db,
    CancellationToken cancellationToken) =>
{
    var product = await db.Products.FindAsync([id], cancellationToken);
    if (product is null)
    {
        return Results.NotFound();
    }

    db.Products.Remove(product);
    await db.SaveChangesAsync(cancellationToken);
    return Results.NoContent();
});

app.Run();

static ProductResponse ToResponse(Product product) =>
    new(
        product.Id,
        product.Name,
        product.Category,
        product.Price,
        product.Stock,
        product.Barcode,
        product.Sku,
        product.Description,
        product.Location,
        product.Brand,
        product.CreatedAtUtc,
        product.Images
            .OrderBy(image => image.SortOrder)
            .Select(ToImageResponse)
            .ToArray());

static ProductImageResponse ToImageResponse(ProductImage image) =>
    new(image.Id, image.FileName, image.ContentType, image.SortOrder);

static async Task<string?> FindUniqueFieldConflictAsync(
    ProductRequest request,
    Guid? excludeId,
    ProductDbContext db,
    CancellationToken cancellationToken)
{
    var barcode = NormalizeOptional(request.Barcode);
    if (barcode is not null && await db.Products.AnyAsync(
            product => product.Barcode == barcode
                && (!excludeId.HasValue || product.Id != excludeId.Value),
            cancellationToken))
    {
        return "Barcode is already assigned to another product.";
    }

    var sku = NormalizeOptional(request.Sku);
    if (sku is not null && await db.Products.AnyAsync(
            product => product.Sku == sku
                && (!excludeId.HasValue || product.Id != excludeId.Value),
            cancellationToken))
    {
        return "SKU is already assigned to another product.";
    }

    return null;
}

static string? NormalizeOptional(string? value) =>
    string.IsNullOrWhiteSpace(value) ? null : value.Trim();

static string? DetectImageContentType(ReadOnlySpan<byte> data)
{
    if (data.Length >= 3 && data[0] == 0xFF && data[1] == 0xD8 && data[2] == 0xFF)
    {
        return "image/jpeg";
    }

    if (data.Length >= 8
        && data[..8].SequenceEqual(new byte[] { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A }))
    {
        return "image/png";
    }

    if (data.Length >= 12
        && data[..4].SequenceEqual("RIFF"u8)
        && data[8..12].SequenceEqual("WEBP"u8))
    {
        return "image/webp";
    }

    return null;
}

static Dictionary<string, string[]> Validate(ProductRequest request)
{
    var errors = new Dictionary<string, string[]>();

    if (string.IsNullOrWhiteSpace(request.Name))
    {
        errors["name"] = ["Name is required."];
    }
    else if (request.Name.Length > 120)
    {
        errors["name"] = ["Name must be 120 characters or fewer."];
    }

    if (string.IsNullOrWhiteSpace(request.Category))
    {
        errors["category"] = ["Category is required."];
    }
    else if (request.Category.Length > 80)
    {
        errors["category"] = ["Category must be 80 characters or fewer."];
    }

    if (request.Price < 0)
    {
        errors["price"] = ["Price cannot be negative."];
    }

    if (request.Stock < 0)
    {
        errors["stock"] = ["Stock cannot be negative."];
    }

    if (request.Barcode?.Length > 64)
    {
        errors["barcode"] = ["Barcode must be 64 characters or fewer."];
    }

    if (request.Sku?.Length > 64)
    {
        errors["sku"] = ["SKU must be 64 characters or fewer."];
    }

    if (request.Description?.Length > 2000)
    {
        errors["description"] = ["Description must be 2,000 characters or fewer."];
    }

    if (request.Location?.Length > 120)
    {
        errors["location"] = ["Location must be 120 characters or fewer."];
    }

    if (request.Brand?.Length > 120)
    {
        errors["brand"] = ["Brand must be 120 characters or fewer."];
    }

    return errors;
}
