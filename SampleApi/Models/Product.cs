namespace SampleApi.Models;

public sealed class Product
{
    public Guid Id { get; set; }
    public string Name { get; set; } = string.Empty;
    public string Category { get; set; } = string.Empty;
    public decimal Price { get; set; }
    public int Stock { get; set; }
}

public sealed record ProductRequest(
    string Name,
    string Category,
    decimal Price,
    int Stock);
