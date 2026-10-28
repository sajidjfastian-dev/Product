using Microsoft.EntityFrameworkCore;
using SampleApi.Models;

namespace SampleApi.Data;

public sealed class ProductDbContext(DbContextOptions<ProductDbContext> options) : DbContext(options)
{
    public DbSet<Product> Products => Set<Product>();
    public DbSet<ProductImage> ProductImages => Set<ProductImage>();
    public DbSet<DatabaseSeedState> SeedStates => Set<DatabaseSeedState>();
    public DbSet<PortalUser> PortalUsers => Set<PortalUser>();
    public DbSet<PortalRole> PortalRoles => Set<PortalRole>();
    public DbSet<PortalUserRole> PortalUserRoles => Set<PortalUserRole>();
    public DbSet<PortalRolePermission> PortalRolePermissions => Set<PortalRolePermission>();
    public DbSet<InventoryMovement> InventoryMovements => Set<InventoryMovement>();
    public DbSet<AuditEvent> AuditEvents => Set<AuditEvent>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        var product = modelBuilder.Entity<Product>();
        product.HasKey(item => item.Id);
        product.Property(item => item.Name).HasMaxLength(120).IsRequired();
        product.Property(item => item.Category).HasMaxLength(80).IsRequired();
        product.Property(item => item.Price).HasPrecision(18, 2);
        product.Property(item => item.ReorderLevel).HasDefaultValue(10);
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

        var user = modelBuilder.Entity<PortalUser>();
        user.HasKey(item => item.Id);
        user.Property(item => item.Email).HasMaxLength(254).IsRequired();
        user.Property(item => item.DisplayName).HasMaxLength(120).IsRequired();
        user.Property(item => item.PasswordHash).HasMaxLength(512).IsRequired();
        user.Property(item => item.SecurityStamp).HasMaxLength(36).IsRequired();
        user.HasIndex(item => item.Email).IsUnique();

        var role = modelBuilder.Entity<PortalRole>();
        role.HasKey(item => item.Id);
        role.Property(item => item.Name).HasMaxLength(80).IsRequired();
        role.HasIndex(item => item.Name).IsUnique();

        var userRole = modelBuilder.Entity<PortalUserRole>();
        userRole.HasKey(item => new { item.UserId, item.RoleId });
        userRole.HasOne(item => item.User).WithMany(item => item.UserRoles).HasForeignKey(item => item.UserId);
        userRole.HasOne(item => item.Role).WithMany(item => item.UserRoles).HasForeignKey(item => item.RoleId);

        var rolePermission = modelBuilder.Entity<PortalRolePermission>();
        rolePermission.HasKey(item => new { item.RoleId, item.Permission });
        rolePermission.Property(item => item.Permission).HasMaxLength(100);
        rolePermission.HasOne(item => item.Role).WithMany(item => item.Permissions).HasForeignKey(item => item.RoleId);

        var movement = modelBuilder.Entity<InventoryMovement>();
        movement.HasKey(item => item.Id);
        movement.Property(item => item.MovementType).HasMaxLength(40).IsRequired();
        movement.Property(item => item.Reason).HasMaxLength(300).IsRequired();
        movement.Property(item => item.Reference).HasMaxLength(120);
        movement.Property(item => item.CreatedByEmail).HasMaxLength(254);
        movement.Property(item => item.CreatedAtUtc).HasDefaultValueSql("SYSUTCDATETIME()");
        movement.HasOne(item => item.Product).WithMany().HasForeignKey(item => item.ProductId).OnDelete(DeleteBehavior.Restrict);
        movement.HasIndex(item => item.CreatedAtUtc);
        movement.HasIndex(item => new { item.ProductId, item.CreatedAtUtc });

        var audit = modelBuilder.Entity<AuditEvent>();
        audit.HasKey(item => item.Id);
        audit.Property(item => item.UserEmail).HasMaxLength(254);
        audit.Property(item => item.Action).HasMaxLength(80).IsRequired();
        audit.Property(item => item.EntityType).HasMaxLength(80).IsRequired();
        audit.Property(item => item.EntityId).HasMaxLength(120);
        audit.Property(item => item.Details).HasMaxLength(2000);
        audit.Property(item => item.CreatedAtUtc).HasDefaultValueSql("SYSUTCDATETIME()");
        audit.HasIndex(item => item.CreatedAtUtc);
    }
}
