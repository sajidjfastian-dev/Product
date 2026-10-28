namespace SampleApi.Models;

public sealed class Product
{
    public Guid Id { get; set; }
    public string Name { get; set; } = string.Empty;
    public string Category { get; set; } = string.Empty;
    public decimal Price { get; set; }
    public int Stock { get; set; }
    public string? Barcode { get; set; }
    public string? Sku { get; set; }
    public string? Description { get; set; }
    public string? Location { get; set; }
    public string? Brand { get; set; }
    public DateTime CreatedAtUtc { get; set; }
    public ICollection<ProductImage> Images { get; set; } = new List<ProductImage>();
}

public sealed record ProductRequest(
    string Name,
    string Category,
    decimal Price,
    int Stock,
    string? Barcode,
    string? Sku,
    string? Description,
    string? Location,
    string? Brand);

public sealed class ProductImage
{
    public Guid Id { get; set; }
    public Guid ProductId { get; set; }
    public string FileName { get; set; } = string.Empty;
    public string ContentType { get; set; } = string.Empty;
    public int ContentLength { get; set; }
    public byte[] Data { get; set; } = [];
    public int SortOrder { get; set; }
    public DateTime CreatedAtUtc { get; set; }
    public Product Product { get; set; } = null!;
}

public sealed record ProductImageResponse(
    Guid Id,
    string FileName,
    string ContentType,
    int SortOrder);

public sealed record ProductResponse(
    Guid Id,
    string Name,
    string Category,
    decimal Price,
    int Stock,
    string? Barcode,
    string? Sku,
    string? Description,
    string? Location,
    string? Brand,
    DateTime CreatedAtUtc,
    IReadOnlyList<ProductImageResponse> Images);

public sealed record ProductListResponse(
    IReadOnlyList<ProductResponse> Items,
    int TotalCount,
    int Page,
    int PageSize);

public sealed record ProductImageUploadResponse(
    IReadOnlyList<ProductImageResponse> Images);
