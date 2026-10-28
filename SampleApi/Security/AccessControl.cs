using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.EntityFrameworkCore;
using SampleApi.Data;
using SampleApi.Models;

namespace SampleApi.Security;

public static class Permissions
{
    public const string ProductsRead = "products.read";
    public const string ProductsWrite = "products.write";
    public const string InventoryRead = "inventory.read";
    public const string InventoryAdjust = "inventory.adjust";
    public const string PurchasesManage = "purchases.manage";
    public const string SalesManage = "sales.manage";
    public const string ReportsRead = "reports.read";
    public const string UsersManage = "users.manage";
    public const string AuditRead = "audit.read";
}

public sealed record RoleDefinition(string Name, IReadOnlyList<string> Permissions);

public static class RoleCatalog
{
    private static readonly string[] AllPermissions =
    [
        Permissions.ProductsRead, Permissions.ProductsWrite,
        Permissions.InventoryRead, Permissions.InventoryAdjust,
        Permissions.PurchasesManage, Permissions.SalesManage,
        Permissions.ReportsRead, Permissions.UsersManage, Permissions.AuditRead
    ];

    public static readonly IReadOnlyList<RoleDefinition> Definitions =
    [
        new("Administrator", AllPermissions),
        new("Inventory Manager",
        [
            Permissions.ProductsRead, Permissions.ProductsWrite,
            Permissions.InventoryRead, Permissions.InventoryAdjust,
            Permissions.PurchasesManage, Permissions.SalesManage,
            Permissions.ReportsRead, Permissions.AuditRead
        ]),
        new("Warehouse Operator",
        [
            Permissions.ProductsRead, Permissions.InventoryRead, Permissions.InventoryAdjust
        ]),
        new("Purchasing",
        [
            Permissions.ProductsRead, Permissions.InventoryRead,
            Permissions.PurchasesManage, Permissions.ReportsRead
        ]),
        new("Sales",
        [
            Permissions.ProductsRead, Permissions.InventoryRead,
            Permissions.SalesManage, Permissions.ReportsRead
        ]),
        new("Read-only Auditor",
        [
            Permissions.ProductsRead, Permissions.InventoryRead,
            Permissions.ReportsRead, Permissions.AuditRead
        ])
    ];

    public static async Task SeedAsync(ProductDbContext db, CancellationToken cancellationToken)
    {
        var existingRoles = await db.PortalRoles
            .Include(role => role.Permissions)
            .ToDictionaryAsync(role => role.Name, StringComparer.OrdinalIgnoreCase, cancellationToken);

        foreach (var definition in Definitions)
        {
            if (!existingRoles.TryGetValue(definition.Name, out var role))
            {
                role = new PortalRole { Id = Guid.NewGuid(), Name = definition.Name };
                db.PortalRoles.Add(role);
            }

            var permissions = definition.Permissions.ToHashSet(StringComparer.Ordinal);
            foreach (var existingPermission in role.Permissions
                         .Where(permission => !permissions.Contains(permission.Permission)).ToArray())
            {
                db.PortalRolePermissions.Remove(existingPermission);
            }

            var current = role.Permissions.Select(permission => permission.Permission)
                .ToHashSet(StringComparer.Ordinal);
            foreach (var permission in permissions.Where(permission => !current.Contains(permission)))
            {
                role.Permissions.Add(new PortalRolePermission { RoleId = role.Id, Permission = permission });
            }
        }

        await db.SaveChangesAsync(cancellationToken);
    }

    public static string[] AllPermissionNames() => AllPermissions;
}

public sealed class PermissionRequirement(string permission) : IAuthorizationRequirement
{
    public string Permission { get; } = permission;
}

public sealed class PermissionAuthorizationHandler : AuthorizationHandler<PermissionRequirement>
{
    protected override Task HandleRequirementAsync(
        AuthorizationHandlerContext context,
        PermissionRequirement requirement)
    {
        if (context.User.HasClaim("permission", requirement.Permission))
        {
            context.Succeed(requirement);
        }

        return Task.CompletedTask;
    }
}

public static class AuditLog
{
    public static async Task RecordAsync(
        ProductDbContext db,
        ClaimsPrincipal actor,
        string action,
        string entityType,
        string? entityId,
        object? details,
        CancellationToken cancellationToken)
    {
        var userId = actor.FindFirstValue(ClaimTypes.NameIdentifier);
        db.AuditEvents.Add(new AuditEvent
        {
            Id = Guid.NewGuid(),
            UserId = Guid.TryParse(userId, out var id) ? id : null,
            UserEmail = actor.FindFirstValue(ClaimTypes.Email),
            Action = action,
            EntityType = entityType,
            EntityId = entityId,
            Details = details is null ? null : JsonSerializer.Serialize(details),
            CreatedAtUtc = DateTime.UtcNow
        });
        await db.SaveChangesAsync(cancellationToken);
    }
}
