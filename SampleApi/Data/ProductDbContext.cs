using Microsoft.EntityFrameworkCore;
using SampleApi.Models;

namespace SampleApi.Data;

public sealed class ProductDbContext(DbContextOptions<ProductDbContext> options) : DbContext(options)
{
    public DbSet<Product> Products => Set<Product>();
    public DbSet<DatabaseSeedState> SeedStates => Set<DatabaseSeedState>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        var product = modelBuilder.Entity<Product>();
        product.HasKey(item => item.Id);
        product.Property(item => item.Name).HasMaxLength(120).IsRequired();
        product.Property(item => item.Category).HasMaxLength(80).IsRequired();
        product.Property(item => item.Price).HasPrecision(18, 2);
        modelBuilder.Entity<DatabaseSeedState>().HasKey(state => state.Key);
        modelBuilder.Entity<DatabaseSeedState>().Property(state => state.Key).HasMaxLength(80);
    }
}
