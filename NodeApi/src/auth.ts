import { randomBytes, randomUUID } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { getPool, sql } from "./db.js";
import {
  cookieOptions, makePasswordHash, makeSession, requirePermission,
  requireUser, validPassword, verifyPasswordHash,
} from "./security.js";

const ALL_PERMISSIONS = [
  "products.read", "products.write", "inventory.read", "inventory.adjust",
  "purchases.manage", "sales.manage", "reports.read", "users.manage", "audit.read",
];
const ROLES = [
  { name: "Administrator", permissions: ALL_PERMISSIONS },
  { name: "Inventory Manager", permissions: ["products.read", "products.write", "inventory.read", "inventory.adjust", "purchases.manage", "sales.manage", "reports.read", "audit.read"] },
  { name: "Warehouse Operator", permissions: ["products.read", "inventory.read", "inventory.adjust"] },
  { name: "Purchasing", permissions: ["products.read", "inventory.read", "purchases.manage", "reports.read"] },
  { name: "Sales", permissions: ["products.read", "inventory.read", "sales.manage", "reports.read"] },
  { name: "Read-only Auditor", permissions: ["products.read", "inventory.read", "reports.read", "audit.read"] },
];

export async function seedRoles(): Promise<void> {
  const pool = await getPool();
  for (const definition of ROLES) {
    let result = await pool.request().input("name", sql.NVarChar(80), definition.name)
      .query<{ Id: string }>("SELECT Id FROM dbo.PortalRoles WHERE Name = @name");
    let roleId = result.recordset[0]?.Id;
    if (!roleId) {
      roleId = randomUUID();
      await pool.request().input("id", sql.UniqueIdentifier, roleId)
        .input("name", sql.NVarChar(80), definition.name)
        .query("INSERT INTO dbo.PortalRoles(Id, Name) VALUES(@id, @name)");
    }

    await pool.request().input("roleId", sql.UniqueIdentifier, roleId)
      .query("DELETE FROM dbo.PortalRolePermissions WHERE RoleId = @roleId");
    for (const permission of definition.permissions) {
      await pool.request().input("roleId", sql.UniqueIdentifier, roleId)
        .input("permission", sql.NVarChar(100), permission)
        .query("INSERT INTO dbo.PortalRolePermissions(RoleId, Permission) VALUES(@roleId, @permission)");
    }
  }
}

function isEmail(value: unknown): value is string {
  return typeof value === "string" && value.length <= 254
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

function setSession(response: Response, token: string) {
  response.cookie("Stockroom.Auth", token, cookieOptions());
}

async function writeAuditInTransaction(
  transaction: sql.Transaction,
  userId: string,
  email: string,
  action: string,
  entityType: string,
  entityId: string,
  details: object | null,
): Promise<void> {
  await new sql.Request(transaction)
    .input("id", sql.UniqueIdentifier, randomUUID())
    .input("userId", sql.UniqueIdentifier, userId)
    .input("email", sql.NVarChar(254), email)
    .input("action", sql.NVarChar(80), action)
    .input("entityType", sql.NVarChar(80), entityType)
    .input("entityId", sql.NVarChar(120), entityId)
    .input("details", sql.NVarChar(2000), details ? JSON.stringify(details) : null)
    .query(`INSERT INTO dbo.AuditEvents(Id, UserId, UserEmail, Action, EntityType, EntityId, Details)
      VALUES(@id, @userId, @email, @action, @entityType, @entityId, @details)`);
}

async function accountAccess(userId: string) {
  const pool = await getPool();
  const result = await pool.request().input("id", sql.UniqueIdentifier, userId)
    .query<{ Name: string; Permission: string }>(`
      SELECT r.Name, p.Permission FROM dbo.PortalUserRoles ur
      JOIN dbo.PortalRoles r ON r.Id = ur.RoleId
      JOIN dbo.PortalRolePermissions p ON p.RoleId = r.Id
      WHERE ur.UserId = @id`);
  return {
    roles: [...new Set(result.recordset.map((item) => item.Name))],
    permissions: [...new Set(result.recordset.map((item) => item.Permission))],
  };
}

async function principalFor(userId: string) {
  const pool = await getPool();
  const result = await pool.request().input("id", sql.UniqueIdentifier, userId)
    .query<{ Id: string; Email: string; DisplayName: string; SecurityStamp: string }>(
      "SELECT Id, Email, DisplayName, SecurityStamp FROM dbo.PortalUsers WHERE Id = @id AND IsActive = 1");
  const user = result.recordset[0];
  if (!user) return null;
  const access = await accountAccess(user.Id);
  return { ...user, ...access, stamp: user.SecurityStamp };
}

export const authRouter = Router();

authRouter.get("/csrf", (_request, response) => {
  const token = randomBytes(32).toString("base64url");
  response.cookie("Stockroom.Csrf", token, {
    httpOnly: false, secure: process.env.COOKIE_SECURE === "true",
    sameSite: "strict", path: "/", maxAge: 30 * 60 * 1000,
  });
  response.json({ requestToken: token });
});

authRouter.get("/status", async (_request, response) => {
  const pool = await getPool();
  const users = await pool.request().query("SELECT TOP (1) 1 AS HasUser FROM dbo.PortalUsers");
  response.json({ setupRequired: users.recordset.length === 0 });
});

authRouter.post("/bootstrap", async (request, response) => {
  const { email, displayName, password } = request.body as Record<string, unknown>;
  if (!isEmail(email) || typeof displayName !== "string" || !displayName.trim()
    || displayName.trim().length > 120 || typeof password !== "string" || !validPassword(password)) {
    response.status(400).json({
      message: "Enter a valid email and display name. Passwords must be at least 12 characters with uppercase, lowercase, a number, and a symbol.",
    });
    return;
  }

  const pool = await getPool();
  const transaction = new sql.Transaction(pool);
  await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  let transactionFinished = false;
  try {
    const existing = await new sql.Request(transaction)
      .query("SELECT TOP (1) Id FROM dbo.PortalUsers WITH (UPDLOCK, HOLDLOCK)");
    if (existing.recordset.length) {
      await transaction.rollback();
      transactionFinished = true;
      response.status(409).json({ message: "Initial administrator setup has already been completed." });
      return;
    }

    const roleResult = await new sql.Request(transaction)
      .input("name", sql.NVarChar(80), "Administrator")
      .query<{ Id: string }>("SELECT Id FROM dbo.PortalRoles WHERE Name = @name");
    const roleId = roleResult.recordset[0]?.Id;
    if (!roleId) throw new Error("Administrator role has not been initialized.");

    const id = randomUUID();
    const normalizedEmail = normalizeEmail(email);
    await new sql.Request(transaction)
      .input("id", sql.UniqueIdentifier, id)
      .input("email", sql.NVarChar(254), normalizedEmail)
      .input("name", sql.NVarChar(120), displayName.trim())
      .input("password", sql.NVarChar(512), makePasswordHash(password))
      .input("roleId", sql.UniqueIdentifier, roleId)
      .query(`INSERT INTO dbo.PortalUsers(Id, Email, DisplayName, PasswordHash, SecurityStamp, IsActive)
        VALUES(@id, @email, @name, @password, CONVERT(nvarchar(36), NEWID()), 1);
        INSERT INTO dbo.PortalUserRoles(UserId, RoleId) VALUES(@id, @roleId)`);
    const stamp = await new sql.Request(transaction)
      .input("id", sql.UniqueIdentifier, id)
      .query<{ SecurityStamp: string }>("SELECT SecurityStamp FROM dbo.PortalUsers WHERE Id = @id");
    await new sql.Request(transaction)
      .input("auditId", sql.UniqueIdentifier, randomUUID())
      .input("id", sql.UniqueIdentifier, id)
      .input("email", sql.NVarChar(254), normalizedEmail)
      .query(`INSERT INTO dbo.AuditEvents(Id, UserId, UserEmail, Action, EntityType, EntityId, Details)
        VALUES(@auditId, @id, @email, N'Bootstrap administrator created', N'PortalUser', CONVERT(nvarchar(36), @id), N'{}')`);
    await transaction.commit();
    transactionFinished = true;

    const principal = await principalFor(id);
    if (!principal || !stamp.recordset[0]) throw new Error("Administrator account was created but could not be loaded.");
    setSession(response, await makeSession({
      id, email: principal.Email, displayName: principal.DisplayName,
      roles: principal.roles, permissions: principal.permissions, stamp: stamp.recordset[0].SecurityStamp,
    }));
    response.status(201).location("/api/auth/me").json({
      id, email: principal.Email, displayName: principal.DisplayName,
      roles: principal.roles, permissions: principal.permissions,
    });
  } catch (error) {
    if (!transactionFinished) await transaction.rollback();
    throw error;
  }
});

authRouter.post("/login", async (request, response) => {
  const { email, password } = request.body as Record<string, unknown>;
  if (!isEmail(email) || typeof password !== "string") {
    response.status(401).json({ message: "Email or password is incorrect." });
    return;
  }
  const pool = await getPool();
  const normalizedEmail = normalizeEmail(email);
  const result = await pool.request().input("email", sql.NVarChar(254), normalizedEmail)
    .query<{ Id: string; Email: string; DisplayName: string; PasswordHash: string; SecurityStamp: string; IsActive: boolean; FailedLoginAttempts: number; LockedUntilUtc: Date | null }>(
      `SELECT Id, Email, DisplayName, PasswordHash, SecurityStamp, IsActive, FailedLoginAttempts, LockedUntilUtc
       FROM dbo.PortalUsers WHERE Email = @email`);
  const user = result.recordset[0];
  if (!user || !user.IsActive || (user.LockedUntilUtc && user.LockedUntilUtc > new Date())) {
    response.status(401).json({ message: "Email or password is incorrect." });
    return;
  }
  if (!verifyPasswordHash(password, user.PasswordHash)) {
    const failures = user.FailedLoginAttempts + 1;
    await pool.request().input("id", sql.UniqueIdentifier, user.Id)
      .input("failures", sql.Int, failures >= 5 ? 0 : failures)
      .input("locked", sql.DateTime2, failures >= 5 ? new Date(Date.now() + 15 * 60_000) : null)
      .query("UPDATE dbo.PortalUsers SET FailedLoginAttempts = @failures, LockedUntilUtc = @locked WHERE Id = @id");
    response.status(401).json({ message: "Email or password is incorrect." });
    return;
  }

  await pool.request().input("id", sql.UniqueIdentifier, user.Id)
    .query("UPDATE dbo.PortalUsers SET FailedLoginAttempts = 0, LockedUntilUtc = NULL, LastLoginAtUtc = SYSUTCDATETIME() WHERE Id = @id");
  const principal = await principalFor(user.Id);
  if (!principal) {
    response.status(401).json({ message: "Account is unavailable." });
    return;
  }
  setSession(response, await makeSession({
    id: user.Id, email: principal.Email, displayName: principal.DisplayName,
    roles: principal.roles, permissions: principal.permissions, stamp: principal.stamp,
  }));
  response.json({ id: user.Id, email: principal.Email, displayName: principal.DisplayName, roles: principal.roles, permissions: principal.permissions });
});

authRouter.get("/me", requireUser, (request, response) => {
  const user = request.principal!;
  response.json({ id: user.id, email: user.email, displayName: user.displayName, roles: user.roles, permissions: user.permissions });
});

authRouter.post("/logout", requireUser, (_request, response) => {
  response.clearCookie("Stockroom.Auth", cookieOptions());
  response.sendStatus(204);
});

const admin = Router();
admin.use(requireUser, requirePermission("users.manage"));
admin.get("/roles", (_request, response) => {
  response.json({ roles: ROLES, availablePermissions: ALL_PERMISSIONS });
});
admin.get("/users", async (_request, response) => {
  const pool = await getPool();
  const result = await pool.request().query<{
    Id: string; Email: string; DisplayName: string; IsActive: boolean; CreatedAtUtc: Date; LastLoginAtUtc: Date | null; Role: string | null;
  }>(`SELECT u.Id, u.Email, u.DisplayName, u.IsActive, u.CreatedAtUtc, u.LastLoginAtUtc, r.Name AS Role
      FROM dbo.PortalUsers u LEFT JOIN dbo.PortalUserRoles ur ON ur.UserId = u.Id
      LEFT JOIN dbo.PortalRoles r ON r.Id = ur.RoleId ORDER BY u.CreatedAtUtc DESC`);
  const users = new Map<string, Record<string, unknown>>();
  for (const row of result.recordset) {
    const item = users.get(row.Id) ?? {
      id: row.Id, email: row.Email, displayName: row.DisplayName,
      isActive: row.IsActive, createdAtUtc: row.CreatedAtUtc,
      lastLoginAtUtc: row.LastLoginAtUtc, roles: [],
    };
    if (row.Role) (item.roles as string[]).push(row.Role);
    users.set(row.Id, item);
  }
  response.json([...users.values()]);
});
admin.post("/users", async (request, response) => {
  const { email, displayName, temporaryPassword, roles } = request.body as Record<string, unknown>;
  if (!isEmail(email) || typeof displayName !== "string" || !displayName.trim()
    || typeof temporaryPassword !== "string" || !validPassword(temporaryPassword)
    || !Array.isArray(roles) || !roles.length || !roles.every((role) => typeof role === "string")) {
    response.status(400).json({ message: "Enter a valid email, display name, strong temporary password, and at least one role." });
    return;
  }
  const pool = await getPool();
  const id = randomUUID();
  const transaction = new sql.Transaction(pool);
  await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  let transactionFinished = false;
  try {
    const roleRows = await new sql.Request(transaction)
      .query<{ Id: string; Name: string }>("SELECT Id, Name FROM dbo.PortalRoles");
    const requested = [...new Set(roles as string[])];
    const selected = roleRows.recordset.filter((item) => requested.includes(item.Name));
    if (selected.length !== requested.length) {
      await transaction.rollback();
      transactionFinished = true;
      response.status(400).json({ message: "One or more selected roles are invalid." });
      return;
    }
    await new sql.Request(transaction)
      .input("id", sql.UniqueIdentifier, id)
      .input("email", sql.NVarChar(254), normalizeEmail(email))
      .input("name", sql.NVarChar(120), displayName.trim())
      .input("password", sql.NVarChar(512), makePasswordHash(temporaryPassword))
      .query(`INSERT INTO dbo.PortalUsers(Id, Email, DisplayName, PasswordHash, SecurityStamp, IsActive)
        VALUES(@id, @email, @name, @password, CONVERT(nvarchar(36), NEWID()), 1)`);
    for (const role of selected) {
      await new sql.Request(transaction).input("id", sql.UniqueIdentifier, id)
        .input("roleId", sql.UniqueIdentifier, role.Id)
        .query("INSERT INTO dbo.PortalUserRoles(UserId, RoleId) VALUES(@id, @roleId)");
    }
    await writeAuditInTransaction(
      transaction, request.principal!.id, request.principal!.email,
      "User created", "PortalUser", id, { email: normalizeEmail(email), roles },
    );
    await transaction.commit();
    transactionFinished = true;
    response.status(201).json({ id });
  } catch (error) {
    if (!transactionFinished) await transaction.rollback();
    if ((error as { number?: number }).number === 2601 || (error as { number?: number }).number === 2627) {
      response.status(409).json({ message: "An account with that email already exists." });
      return;
    }
    throw error;
  }
});
admin.put("/users/:id/roles", async (request, response) => {
  const roles = (request.body as { roles?: unknown }).roles;
  if (!Array.isArray(roles) || !roles.every((role) => typeof role === "string")) {
    response.status(400).json({ message: "Select at least one valid role." });
    return;
  }
  const requested = [...new Set(roles as string[])];
  if (!requested.length) {
    response.status(400).json({ message: "Assign at least one valid role." });
    return;
  }
  const id = String(request.params.id);
  const pool = await getPool();
  const transaction = new sql.Transaction(pool);
  await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  let transactionFinished = false;
  try {
    const user = await new sql.Request(transaction).input("id", sql.UniqueIdentifier, id)
      .query<{ Id: string; IsActive: boolean; HasAdministratorRole: number }>(`
        SELECT u.Id, u.IsActive,
          CASE WHEN EXISTS (
            SELECT 1 FROM dbo.PortalUserRoles ur JOIN dbo.PortalRoles r ON r.Id=ur.RoleId
            WHERE ur.UserId=u.Id AND r.Name=N'Administrator'
          ) THEN 1 ELSE 0 END AS HasAdministratorRole
        FROM dbo.PortalUsers u WITH (UPDLOCK, HOLDLOCK) WHERE u.Id=@id`);
    const current = user.recordset[0];
    if (!current) {
      await transaction.rollback();
      transactionFinished = true;
      response.sendStatus(404);
      return;
    }
    const rolesResult = await new sql.Request(transaction)
      .query<{ Id: string; Name: string }>("SELECT Id, Name FROM dbo.PortalRoles");
    const selected = rolesResult.recordset.filter((item) => requested.includes(item.Name));
    if (selected.length !== requested.length) {
      await transaction.rollback();
      transactionFinished = true;
      response.status(400).json({ message: "One or more selected roles are invalid." });
      return;
    }
    if (current.IsActive && current.HasAdministratorRole
      && !selected.some((role) => role.Name === "Administrator")) {
      const count = await new sql.Request(transaction)
        .query<{ Total: number }>(`SELECT COUNT(*) AS Total FROM dbo.PortalUsers u WITH (UPDLOCK, HOLDLOCK)
          JOIN dbo.PortalUserRoles ur ON ur.UserId=u.Id
          JOIN dbo.PortalRoles r ON r.Id=ur.RoleId
          WHERE u.IsActive=1 AND r.Name=N'Administrator'`);
      if ((count.recordset[0]?.Total ?? 0) <= 1) {
        await transaction.rollback();
        transactionFinished = true;
        response.status(409).json({ message: "The last active administrator must retain administrator access." });
        return;
      }
    }
    await new sql.Request(transaction).input("id", sql.UniqueIdentifier, id)
      .query("DELETE FROM dbo.PortalUserRoles WHERE UserId = @id");
    for (const role of selected) {
      await new sql.Request(transaction).input("id", sql.UniqueIdentifier, id)
        .input("roleId", sql.UniqueIdentifier, role.Id)
        .query("INSERT INTO dbo.PortalUserRoles(UserId, RoleId) VALUES(@id, @roleId)");
    }
    await new sql.Request(transaction).input("id", sql.UniqueIdentifier, id)
      .query("UPDATE dbo.PortalUsers SET SecurityStamp = CONVERT(nvarchar(36), NEWID()) WHERE Id = @id");
    await writeAuditInTransaction(
      transaction, request.principal!.id, request.principal!.email,
      "User roles changed", "PortalUser", id, { roles: requested },
    );
    await transaction.commit();
    transactionFinished = true;
    response.sendStatus(204);
  } catch (error) {
    if (!transactionFinished) await transaction.rollback();
    throw error;
  }
});
admin.put("/users/:id/active", async (request, response) => {
  const { isActive } = request.body as { isActive?: unknown };
  if (typeof isActive !== "boolean") { response.status(400).json({ message: "isActive must be a boolean." }); return; }
  const id = String(request.params.id);
  if (id === request.principal!.id && !isActive) { response.status(400).json({ message: "You cannot deactivate your own account." }); return; }
  const pool = await getPool();
  const transaction = new sql.Transaction(pool);
  await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  let transactionFinished = false;
  try {
    const user = await new sql.Request(transaction).input("id", sql.UniqueIdentifier, id)
      .query<{ Id: string; IsActive: boolean; HasAdministratorRole: number }>(`
        SELECT u.Id, u.IsActive,
          CASE WHEN EXISTS (
            SELECT 1 FROM dbo.PortalUserRoles ur JOIN dbo.PortalRoles r ON r.Id=ur.RoleId
            WHERE ur.UserId=u.Id AND r.Name=N'Administrator'
          ) THEN 1 ELSE 0 END AS HasAdministratorRole
        FROM dbo.PortalUsers u WITH (UPDLOCK, HOLDLOCK) WHERE u.Id=@id`);
    const current = user.recordset[0];
    if (!current) {
      await transaction.rollback();
      transactionFinished = true;
      response.sendStatus(404);
      return;
    }
    if (current.IsActive && !isActive && current.HasAdministratorRole) {
      const count = await new sql.Request(transaction)
        .query<{ Total: number }>(`SELECT COUNT(*) AS Total FROM dbo.PortalUsers u WITH (UPDLOCK, HOLDLOCK)
          JOIN dbo.PortalUserRoles ur ON ur.UserId=u.Id
          JOIN dbo.PortalRoles r ON r.Id=ur.RoleId
          WHERE u.IsActive=1 AND r.Name=N'Administrator'`);
      if ((count.recordset[0]?.Total ?? 0) <= 1) {
        await transaction.rollback();
        transactionFinished = true;
        response.status(409).json({ message: "The last active administrator cannot be deactivated." });
        return;
      }
    }
    await new sql.Request(transaction).input("id", sql.UniqueIdentifier, id)
      .input("active", sql.Bit, isActive)
      .query("UPDATE dbo.PortalUsers SET IsActive=@active, SecurityStamp=CONVERT(nvarchar(36), NEWID()) WHERE Id=@id");
    await writeAuditInTransaction(
      transaction, request.principal!.id, request.principal!.email,
      isActive ? "User activated" : "User deactivated", "PortalUser", id, null,
    );
    await transaction.commit();
    transactionFinished = true;
    response.sendStatus(204);
  } catch (error) {
    if (!transactionFinished) await transaction.rollback();
    throw error;
  }
});
authRouter.use("/admin", admin);
