using System.Data;
using System.Net.Mail;
using System.Security.Claims;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using SampleApi.Data;
using SampleApi.Models;

namespace SampleApi.Security;

public static class AuthEndpoints
{
    private const int MaxFailedLogins = 5;
    private static readonly TimeSpan LockoutDuration = TimeSpan.FromMinutes(15);

    public static void MapAuthEndpoints(this WebApplication app)
    {
        var auth = app.MapGroup("/api/auth");

        auth.MapGet("/csrf", (HttpContext context, Microsoft.AspNetCore.Antiforgery.IAntiforgery antiforgery) =>
        {
            var tokens = antiforgery.GetAndStoreTokens(context);
            return Results.Ok(new { requestToken = tokens.RequestToken });
        }).AllowAnonymous();

        auth.MapGet("/status", async (ProductDbContext db, CancellationToken cancellationToken) =>
        {
            var hasUsers = await db.PortalUsers.AnyAsync(cancellationToken);
            return Results.Ok(new { setupRequired = !hasUsers });
        }).AllowAnonymous();

        auth.MapPost("/bootstrap", async (
            BootstrapRequest request,
            ProductDbContext db,
            IPasswordHasher<PortalUser> passwordHasher,
            HttpContext context,
            CancellationToken cancellationToken) =>
        {
            if (!IsValidEmail(request.Email) || string.IsNullOrWhiteSpace(request.DisplayName)
                || request.DisplayName.Trim().Length > 120 || !IsStrongPassword(request.Password))
            {
                return Results.ValidationProblem(new Dictionary<string, string[]>
                {
                    ["account"] = ["Enter a valid email and display name. Passwords must be at least 12 characters with uppercase, lowercase, a number, and a symbol."]
                });
            }

            PortalUser? user = null;
            var strategy = db.Database.CreateExecutionStrategy();
            var created = await strategy.ExecuteAsync(async () =>
            {
                await using var transaction = await db.Database.BeginTransactionAsync(
                    IsolationLevel.Serializable,
                    cancellationToken);

                if (await db.PortalUsers.AnyAsync(cancellationToken))
                {
                    await transaction.RollbackAsync(cancellationToken);
                    return false;
                }

                var role = await db.PortalRoles.SingleAsync(
                    item => item.Name == "Administrator",
                    cancellationToken);
                user = new PortalUser
                {
                    Id = Guid.NewGuid(),
                    Email = NormalizeEmail(request.Email),
                    DisplayName = request.DisplayName.Trim(),
                    IsActive = true,
                    CreatedAtUtc = DateTime.UtcNow
                };
                user.PasswordHash = passwordHasher.HashPassword(user, request.Password);
                user.UserRoles.Add(new PortalUserRole { UserId = user.Id, RoleId = role.Id });
                db.PortalUsers.Add(user);
                await db.SaveChangesAsync(cancellationToken);
                await AuditLog.RecordAsync(
                    db, BuildPrincipal(user, [role.Name], RoleCatalog.AllPermissionNames()),
                    "Bootstrap administrator created", "PortalUser", user.Id.ToString(),
                    new { user.Email }, cancellationToken);
                await transaction.CommitAsync(cancellationToken);
                return true;
            });

            if (!created || user is null)
            {
                return Results.Conflict(new { message = "Initial administrator setup has already been completed." });
            }

            var role = RoleCatalog.Definitions.Single(item => item.Name == "Administrator");
            var permissions = RoleCatalog.AllPermissionNames();
            await SignInAsync(context, user, [role.Name], permissions);
            return Results.Created("/api/auth/me", new { user.Id, user.Email, user.DisplayName, roles = new[] { role.Name }, permissions });
        }).AllowAnonymous().RequireRateLimiting("account-bootstrap");

        auth.MapPost("/login", async (
            LoginRequest request,
            ProductDbContext db,
            IPasswordHasher<PortalUser> passwordHasher,
            HttpContext context,
            CancellationToken cancellationToken) =>
        {
            var email = NormalizeEmail(request.Email);
            var user = await db.PortalUsers
                .Include(item => item.UserRoles)
                    .ThenInclude(userRole => userRole.Role)
                        .ThenInclude(role => role.Permissions)
                .SingleOrDefaultAsync(item => item.Email == email, cancellationToken);

            if (user is null || !user.IsActive
                || (user.LockedUntilUtc.HasValue && user.LockedUntilUtc > DateTime.UtcNow))
            {
                return Results.Unauthorized();
            }

            var verification = passwordHasher.VerifyHashedPassword(user, user.PasswordHash, request.Password);
            if (verification == PasswordVerificationResult.Failed)
            {
                user.FailedLoginAttempts++;
                if (user.FailedLoginAttempts >= MaxFailedLogins)
                {
                    user.LockedUntilUtc = DateTime.UtcNow.Add(LockoutDuration);
                    user.FailedLoginAttempts = 0;
                }

                await db.SaveChangesAsync(cancellationToken);
                return Results.Unauthorized();
            }

            user.FailedLoginAttempts = 0;
            user.LockedUntilUtc = null;
            user.LastLoginAtUtc = DateTime.UtcNow;
            if (verification == PasswordVerificationResult.SuccessRehashNeeded)
            {
                user.PasswordHash = passwordHasher.HashPassword(user, request.Password);
            }

            var roles = user.UserRoles.Select(item => item.Role.Name).ToArray();
            var permissions = user.UserRoles.SelectMany(item => item.Role.Permissions)
                .Select(item => item.Permission).Distinct(StringComparer.Ordinal).ToArray();
            await db.SaveChangesAsync(cancellationToken);
            await SignInAsync(context, user, roles, permissions);
            return Results.Ok(new { user.Id, user.Email, user.DisplayName, roles, permissions });
        }).AllowAnonymous().RequireRateLimiting("account-login");

        auth.MapGet("/me", (ClaimsPrincipal principal) =>
            Results.Ok(new
            {
                id = principal.FindFirstValue(ClaimTypes.NameIdentifier),
                email = principal.FindFirstValue(ClaimTypes.Email),
                displayName = principal.Identity?.Name,
                roles = principal.FindAll(ClaimTypes.Role).Select(claim => claim.Value).ToArray(),
                permissions = principal.FindAll("permission").Select(claim => claim.Value).ToArray()
            })).RequireAuthorization();

        auth.MapPost("/logout", async (HttpContext context) =>
        {
            await context.SignOutAsync(CookieAuthenticationDefaults.AuthenticationScheme);
            return Results.NoContent();
        }).RequireAuthorization();

        var admin = auth.MapGroup("/admin").RequireAuthorization("users.manage");
        admin.MapGet("/roles", () => Results.Ok(new
        {
            roles = RoleCatalog.Definitions.Select(role => new { role.Name, permissions = role.Permissions }),
            availablePermissions = RoleCatalog.AllPermissionNames()
        }));

        admin.MapGet("/users", async (ProductDbContext db, CancellationToken cancellationToken) =>
        {
            var users = await db.PortalUsers.AsNoTracking()
                .Include(user => user.UserRoles).ThenInclude(userRole => userRole.Role)
                .OrderBy(user => user.Email)
                .Select(user => new
                {
                    user.Id,
                    user.Email,
                    user.DisplayName,
                    user.IsActive,
                    user.CreatedAtUtc,
                    user.LastLoginAtUtc,
                    roles = user.UserRoles.Select(userRole => userRole.Role.Name).ToArray()
                })
                .ToListAsync(cancellationToken);
            return Results.Ok(users);
        });

        admin.MapPost("/users", async (
            UserCreateRequest request,
            ProductDbContext db,
            IPasswordHasher<PortalUser> passwordHasher,
            ClaimsPrincipal actor,
            CancellationToken cancellationToken) =>
        {
            if (!IsValidEmail(request.Email) || string.IsNullOrWhiteSpace(request.DisplayName)
                || request.DisplayName.Trim().Length > 120 || !IsStrongPassword(request.TemporaryPassword))
            {
                return Results.ValidationProblem(new Dictionary<string, string[]>
                {
                    ["account"] = ["Enter a valid email and display name. Temporary passwords must meet the 12-character complexity requirements."]
                });
            }

            if (await db.PortalUsers.AnyAsync(user => user.Email == NormalizeEmail(request.Email), cancellationToken))
            {
                return Results.Conflict(new { message = "An account with this email already exists." });
            }

            var roles = await ResolveRolesAsync(db, request.Roles, cancellationToken);
            if (roles is null)
            {
                return Results.BadRequest(new { message = "One or more selected roles are invalid." });
            }

            var user = new PortalUser
            {
                Id = Guid.NewGuid(),
                Email = NormalizeEmail(request.Email),
                DisplayName = request.DisplayName.Trim(),
                CreatedAtUtc = DateTime.UtcNow
            };
            user.PasswordHash = passwordHasher.HashPassword(user, request.TemporaryPassword);
            foreach (var role in roles)
            {
                user.UserRoles.Add(new PortalUserRole { UserId = user.Id, RoleId = role.Id });
            }

            db.PortalUsers.Add(user);
            await db.SaveChangesAsync(cancellationToken);
            await AuditLog.RecordAsync(db, actor, "User created", "PortalUser", user.Id.ToString(),
                new { user.Email, roles = roles.Select(role => role.Name) }, cancellationToken);
            return Results.Created($"/api/auth/admin/users/{user.Id}", new { user.Id, user.Email, user.DisplayName });
        });

        admin.MapPut("/users/{id:guid}/roles", async (
            Guid id,
            UserRoleUpdateRequest request,
            ProductDbContext db,
            ClaimsPrincipal actor,
            CancellationToken cancellationToken) =>
        {
            var user = await db.PortalUsers.Include(item => item.UserRoles)
                .SingleOrDefaultAsync(item => item.Id == id, cancellationToken);
            if (user is null)
            {
                return Results.NotFound();
            }

            var roles = await ResolveRolesAsync(db, request.Roles, cancellationToken);
            if (roles is null || roles.Count == 0)
            {
                return Results.BadRequest(new { message = "Assign at least one valid role." });
            }

            var administratorRoleId = await db.PortalRoles
                .Where(role => role.Name == "Administrator")
                .Select(role => role.Id)
                .SingleAsync(cancellationToken);
            var removesLastActiveAdministrator = user.IsActive
                && user.UserRoles.Any(userRole => userRole.RoleId == administratorRoleId)
                && roles.All(role => role.Name != "Administrator")
                && await db.PortalUsers.CountAsync(
                    item => item.IsActive && item.UserRoles.Any(userRole => userRole.Role.Name == "Administrator"),
                    cancellationToken) <= 1;
            if (removesLastActiveAdministrator)
            {
                return Results.Conflict(new { message = "The last active administrator must retain administrator access." });
            }

            var requestedRoleIds = roles.Select(role => role.Id).ToHashSet();
            var removedRoles = user.UserRoles.Where(userRole => !requestedRoleIds.Contains(userRole.RoleId)).ToArray();
            db.PortalUserRoles.RemoveRange(removedRoles);
            foreach (var removedRole in removedRoles)
            {
                user.UserRoles.Remove(removedRole);
            }

            foreach (var role in roles)
            {
                if (user.UserRoles.All(userRole => userRole.RoleId != role.Id))
                {
                    user.UserRoles.Add(new PortalUserRole { UserId = user.Id, RoleId = role.Id });
                }
            }

            user.SecurityStamp = Guid.NewGuid().ToString();
            await db.SaveChangesAsync(cancellationToken);
            await AuditLog.RecordAsync(db, actor, "User roles changed", "PortalUser", user.Id.ToString(),
                new { user.Email, roles = roles.Select(role => role.Name) }, cancellationToken);
            return Results.NoContent();
        });

        admin.MapPut("/users/{id:guid}/active", async (
            Guid id,
            UserActiveRequest request,
            ProductDbContext db,
            ClaimsPrincipal actor,
            CancellationToken cancellationToken) =>
        {
            var user = await db.PortalUsers.Include(item => item.UserRoles)
                .ThenInclude(userRole => userRole.Role)
                .SingleOrDefaultAsync(item => item.Id == id, cancellationToken);
            if (user is null)
            {
                return Results.NotFound();
            }

            if (actor.FindFirstValue(ClaimTypes.NameIdentifier) == id.ToString() && !request.IsActive)
            {
                return Results.BadRequest(new { message = "You cannot deactivate your own account." });
            }

            if (user.IsActive && !request.IsActive
                && user.UserRoles.Any(userRole => userRole.Role.Name == "Administrator")
                && await db.PortalUsers.CountAsync(
                    item => item.IsActive && item.UserRoles.Any(userRole => userRole.Role.Name == "Administrator"),
                    cancellationToken) <= 1)
            {
                return Results.Conflict(new { message = "The last active administrator cannot be deactivated." });
            }

            user.IsActive = request.IsActive;
            user.SecurityStamp = Guid.NewGuid().ToString();
            await db.SaveChangesAsync(cancellationToken);
            await AuditLog.RecordAsync(db, actor, request.IsActive ? "User activated" : "User deactivated",
                "PortalUser", user.Id.ToString(), new { user.Email }, cancellationToken);
            return Results.NoContent();
        });
    }

    private static async Task<List<PortalRole>?> ResolveRolesAsync(
        ProductDbContext db,
        IReadOnlyList<string> requestedRoles,
        CancellationToken cancellationToken)
    {
        var names = requestedRoles.Where(name => !string.IsNullOrWhiteSpace(name))
            .Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
        var roles = await db.PortalRoles.Where(role => names.Contains(role.Name))
            .OrderBy(role => role.Name).ToListAsync(cancellationToken);
        return roles.Count == names.Length ? roles : null;
    }

    private static bool IsValidEmail(string email)
    {
        try
        {
            return email.Length <= 254
                && string.Equals(new MailAddress(email).Address, email, StringComparison.OrdinalIgnoreCase);
        }
        catch (FormatException)
        {
            return false;
        }
    }

    private static bool IsStrongPassword(string password) =>
        password.Length >= 12
        && password.Any(char.IsUpper)
        && password.Any(char.IsLower)
        && password.Any(char.IsDigit)
        && password.Any(character => !char.IsLetterOrDigit(character));

    private static string NormalizeEmail(string email) => email.Trim().ToLowerInvariant();

    private static ClaimsPrincipal BuildPrincipal(
        PortalUser user,
        IReadOnlyList<string> roles,
        IReadOnlyList<string> permissions)
    {
        var claims = new List<Claim>
        {
            new(ClaimTypes.NameIdentifier, user.Id.ToString()),
            new(ClaimTypes.Name, user.DisplayName),
            new(ClaimTypes.Email, user.Email),
            new("security_stamp", user.SecurityStamp)
        };
        claims.AddRange(roles.Select(role => new Claim(ClaimTypes.Role, role)));
        claims.AddRange(permissions.Select(permission => new Claim("permission", permission)));
        return new ClaimsPrincipal(new ClaimsIdentity(
            claims, CookieAuthenticationDefaults.AuthenticationScheme));
    }

    private static Task SignInAsync(
        HttpContext context,
        PortalUser user,
        IReadOnlyList<string> roles,
        IReadOnlyList<string> permissions) =>
        context.SignInAsync(
            CookieAuthenticationDefaults.AuthenticationScheme,
            BuildPrincipal(user, roles, permissions),
            new AuthenticationProperties { IsPersistent = true, AllowRefresh = true });
}

public sealed record UserActiveRequest(bool IsActive);
