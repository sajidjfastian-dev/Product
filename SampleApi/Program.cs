using Microsoft.EntityFrameworkCore;
using SampleApi.Data;
using SampleApi.Models;

var builder = WebApplication.CreateBuilder(args);

var connectionString = builder.Configuration.GetConnectionString("Products")
    ?? throw new InvalidOperationException("Connection string 'Products' is required.");

builder.Services.AddDbContext<ProductDbContext>(options =>
    options.UseSqlServer(connectionString, sql => sql.EnableRetryOnFailure()));

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
    var seedFile = Path.Combine(AppContext.BaseDirectory, "test-data", "products.json");
    await DatabaseSeeder.SeedAsync(db, seedFile);
}

app.MapGet("/health", () => Results.Ok(new { status = "Healthy" }));

var products = app.MapGroup("/api/products");

products.MapGet("/", async (string? category, ProductDbContext db, CancellationToken cancellationToken) =>
{
    var query = db.Products.AsNoTracking();
    if (!string.IsNullOrWhiteSpace(category))
    {
        query = query.Where(product => product.Category == category);
    }

    var items = await query.OrderBy(product => product.Name).ToListAsync(cancellationToken);
    return Results.Ok(items);
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

    var product = new Product
    {
        Id = Guid.NewGuid(),
        Name = request.Name.Trim(),
        Category = request.Category.Trim(),
        Price = request.Price,
        Stock = request.Stock
    };

    db.Products.Add(product);
    await db.SaveChangesAsync(cancellationToken);
    return Results.Created("/api/products", product);
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

    product.Name = request.Name.Trim();
    product.Category = request.Category.Trim();
    product.Price = request.Price;
    product.Stock = request.Stock;

    await db.SaveChangesAsync(cancellationToken);
    return Results.Ok(product);
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

    return errors;
}
