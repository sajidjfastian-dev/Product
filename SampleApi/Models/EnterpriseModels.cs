namespace SampleApi.Models;

public sealed class PortalUser
{
    public Guid Id { get; set; }
    public string Email { get; set; } = string.Empty;
    public string DisplayName { get; set; } = string.Empty;
    public string PasswordHash { get; set; } = string.Empty;
    public string SecurityStamp { get; set; } = Guid.NewGuid().ToString();
    public bool IsActive { get; set; } = true;
    public int FailedLoginAttempts { get; set; }
    public DateTime? LockedUntilUtc { get; set; }
    public DateTime CreatedAtUtc { get; set; }
    public DateTime? LastLoginAtUtc { get; set; }
    public ICollection<PortalUserRole> UserRoles { get; set; } = new List<PortalUserRole>();
}

public sealed class PortalRole
{
    public Guid Id { get; set; }
    public string Name { get; set; } = string.Empty;
    public ICollection<PortalUserRole> UserRoles { get; set; } = new List<PortalUserRole>();
    public ICollection<PortalRolePermission> Permissions { get; set; } = new List<PortalRolePermission>();
}

public sealed class PortalUserRole
{
    public Guid UserId { get; set; }
    public Guid RoleId { get; set; }
    public PortalUser User { get; set; } = null!;
    public PortalRole Role { get; set; } = null!;
}

public sealed class PortalRolePermission
{
    public Guid RoleId { get; set; }
    public string Permission { get; set; } = string.Empty;
    public PortalRole Role { get; set; } = null!;
}

public sealed class InventoryMovement
{
    public Guid Id { get; set; }
    public Guid ProductId { get; set; }
    public string MovementType { get; set; } = string.Empty;
    public int QuantityChange { get; set; }
    public int BalanceAfter { get; set; }
    public string Reason { get; set; } = string.Empty;
    public string? Reference { get; set; }
    public Guid? CreatedByUserId { get; set; }
    public string? CreatedByEmail { get; set; }
    public DateTime CreatedAtUtc { get; set; }
    public Product Product { get; set; } = null!;
}

public sealed class AuditEvent
{
    public Guid Id { get; set; }
    public Guid? UserId { get; set; }
    public string? UserEmail { get; set; }
    public string Action { get; set; } = string.Empty;
    public string EntityType { get; set; } = string.Empty;
    public string? EntityId { get; set; }
    public string? Details { get; set; }
    public DateTime CreatedAtUtc { get; set; }
}

public sealed record BootstrapRequest(string Email, string DisplayName, string Password);
public sealed record LoginRequest(string Email, string Password);
public sealed record UserCreateRequest(string Email, string DisplayName, string TemporaryPassword, IReadOnlyList<string> Roles);
public sealed record UserRoleUpdateRequest(IReadOnlyList<string> Roles);
public sealed record InventoryAdjustmentRequest(Guid ProductId, int QuantityChange, string Reason, string? Reference);
public sealed record InventoryMovementResponse(
    Guid Id,
    Guid ProductId,
    string ProductName,
    string? Sku,
    string MovementType,
    int QuantityChange,
    int BalanceAfter,
    string Reason,
    string? Reference,
    string? CreatedByEmail,
    DateTime CreatedAtUtc);
