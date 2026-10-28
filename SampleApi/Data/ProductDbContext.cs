using Microsoft.EntityFrameworkCore;
using SampleApi.Models;

namespace SampleApi.Data;

public sealed class ProductDbContext(DbContextOptions<ProductDbContext> options) : DbContext(options)
{
    public DbSet<Product> Products => Set<Product>();
    public DbSet<ProductImage> ProductImages => Set<ProductImage>();
    public DbSet<DatabaseSeedState> SeedStates => Set<DatabaseSeedState>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        var product = modelBuilder.Entity<Product>();
        product.HasKey(item => item.Id);
        product.Property(item => item.Name).HasMaxLength(120).IsRequired();
        product.Property(item => item.Category).HasMaxLength(80).IsRequired();
        product.Property(item => item.Price).HasPrecision(18, 2);
        product.Property(item => item.Barcode).HasMaxLength(64);
        product.Property(item => item.Sku).HasMaxLength(64);
        product.Property(item => item.Description).HasMaxLength(2000);
        product.Property(item => item.Location).HasMaxLength(120);
        product.Property(item => item.Brand).HasMaxLength(120);
        product.Property(item => item.CreatedAtUtc).HasDefaultValueSql("SYSUTCDATETIME()");
        product.HasIndex(item => item.Barcode)
            .IsUnique()
            .HasDatabaseName("IX_Products_Barcode")
            .HasFilter("[Barcode] IS NOT NULL AND [Barcode] <> N''");
        product.HasIndex(item => item.Sku)
            .IsUnique()
            .HasDatabaseName("IX_Products_Sku")
            .HasFilter("[Sku] IS NOT NULL AND [Sku] <> N''");

        var image = modelBuilder.Entity<ProductImage>();
        image.HasKey(item => item.Id);
        image.Property(item => item.FileName).HasMaxLength(255).IsRequired();
        image.Property(item => item.ContentType).HasMaxLength(32).IsRequired();
        image.Property(item => item.Data).HasColumnType("varbinary(max)").IsRequired();
        image.Property(item => item.CreatedAtUtc).HasDefaultValueSql("SYSUTCDATETIME()");
        image.HasOne(item => item.Product)
            .WithMany(item => item.Images)
            .HasForeignKey(item => item.ProductId)
            .OnDelete(DeleteBehavior.Cascade);
        image.HasIndex(item => new { item.ProductId, item.SortOrder });

        modelBuilder.Entity<DatabaseSeedState>().HasKey(state => state.Key);
        modelBuilder.Entity<DatabaseSeedState>().Property(state => state.Key).HasMaxLength(80);
    }
}
