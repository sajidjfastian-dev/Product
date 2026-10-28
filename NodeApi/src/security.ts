import { createHmac, randomBytes, timingSafeEqual, pbkdf2Sync } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { NextFunction, Request, Response } from "express";
import { getPool, sql } from "./db.js";

export interface Principal {
  id: string;
  email: string;
  displayName: string;
  roles: string[];
  permissions: string[];
  stamp: string;
}

declare global {
  namespace Express {
    interface Request {
      principal?: Principal;
    }
  }
}

let secretPromise: Promise<Buffer> | undefined;

async function getSessionSecret(): Promise<Buffer> {
  if (process.env.SESSION_SECRET) {
    return Buffer.from(process.env.SESSION_SECRET, "utf8");
  }

  const keyFile = process.env.SESSION_KEY_FILE ?? "/var/lib/stockroom/session.key";
  await mkdir(dirname(keyFile), { recursive: true });
  try {
    const handle = await open(keyFile, "wx", 0o600);
    const generated = randomBytes(48);
    await handle.writeFile(generated);
    await handle.close();
    return generated;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return readFile(keyFile);
  }
}

async function signingKey(): Promise<Buffer> {
  secretPromise ??= getSessionSecret();
  return secretPromise;
}

export async function makeSession(principal: Principal): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({
    sub: principal.id,
    stamp: principal.stamp,
    iat: now,
    exp: now + 30 * 60,
  })).toString("base64url");
  const signingInput = `v1.${payload}`;
  const signature = createHmac("sha256", await signingKey()).update(signingInput).digest("base64url");
  return `${signingInput}.${signature}`;
}

async function readSession(token: string): Promise<{ id: string; stamp: string } | null> {
  const [version, payload, signature, ...rest] = token.split(".");
  if (version !== "v1" || !payload || !signature || rest.length) return null;
  const expected = createHmac("sha256", await signingKey())
    .update(`${version}.${payload}`).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(signature, "base64url");
  } catch {
    return null;
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;

  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      sub?: string;
      stamp?: string;
      exp?: number;
    };
    if (!data.sub || !data.stamp || !data.exp || data.exp <= Date.now() / 1000) return null;
    return { id: data.sub, stamp: data.stamp };
  } catch {
    return null;
  }
}

export async function requireUser(
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  const token = request.cookies?.["Stockroom.Auth"] as string | undefined;
  if (!token) {
    response.status(401).json({ message: "Sign in to continue." });
    return;
  }

  const session = await readSession(token);
  if (!session) {
    response.clearCookie("Stockroom.Auth", cookieOptions());
    response.status(401).json({ message: "Your session has expired. Sign in again." });
    return;
  }

  const pool = await getPool();
  const user = await pool.request()
    .input("id", sql.UniqueIdentifier, session.id)
    .input("stamp", sql.NVarChar(36), session.stamp)
    .query<{
      Id: string;
      Email: string;
      DisplayName: string;
      SecurityStamp: string;
      IsActive: boolean;
    }>(`SELECT Id, Email, DisplayName, SecurityStamp, IsActive
        FROM dbo.PortalUsers WHERE Id = @id AND SecurityStamp = @stamp`);
  const row = user.recordset[0];
  if (!row?.IsActive) {
    response.clearCookie("Stockroom.Auth", cookieOptions());
    response.status(401).json({ message: "Your account is unavailable. Sign in again." });
    return;
  }

  const access = await pool.request()
    .input("id", sql.UniqueIdentifier, row.Id)
    .query<{ Name: string; Permission: string }>(`
      SELECT r.Name, p.Permission
      FROM dbo.PortalUserRoles ur
      JOIN dbo.PortalRoles r ON r.Id = ur.RoleId
      JOIN dbo.PortalRolePermissions p ON p.RoleId = r.Id
      WHERE ur.UserId = @id`);
  request.principal = {
    id: row.Id,
    email: row.Email,
    displayName: row.DisplayName,
    stamp: row.SecurityStamp,
    roles: [...new Set(access.recordset.map((item) => item.Name))],
    permissions: [...new Set(access.recordset.map((item) => item.Permission))],
  };
  next();
}

export function requirePermission(permission: string) {
  return (request: Request, response: Response, next: NextFunction): void => {
    if (!request.principal?.permissions.includes(permission)) {
      response.status(request.principal ? 403 : 401).json({ message: "You do not have permission to perform this action." });
      return;
    }
    next();
  };
}

export function cookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.COOKIE_SECURE === "true",
    sameSite: "strict" as const,
    path: "/",
    maxAge: 30 * 60 * 1000,
  };
}

export function validPassword(password: string): boolean {
  return password.length >= 12 && /[a-z]/.test(password) && /[A-Z]/.test(password)
    && /\d/.test(password) && /[^A-Za-z0-9]/.test(password);
}

export function makePasswordHash(password: string): string {
  const salt = randomBytes(16);
  const subkey = pbkdf2Sync(password, salt, 100_000, 32, "sha512");
  const header = Buffer.alloc(13);
  header[0] = 1;
  header.writeUInt32BE(2, 1);
  header.writeUInt32BE(100_000, 5);
  header.writeUInt32BE(salt.length, 9);
  return Buffer.concat([header, salt, subkey]).toString("base64");
}

export function verifyPasswordHash(password: string, encoded: string): boolean {
  let value: Buffer;
  try {
    value = Buffer.from(encoded, "base64");
  } catch {
    return false;
  }

  let salt: Buffer;
  let expected: Buffer;
  let iterations: number;
  let digest: "sha1" | "sha256" | "sha512";
  if (value.length >= 13 && value[0] === 1) {
    const prf = value.readUInt32BE(1);
    iterations = value.readUInt32BE(5);
    const saltLength = value.readUInt32BE(9);
    if (![0, 1, 2].includes(prf) || iterations < 1 || saltLength < 1
      || value.length <= 13 + saltLength) return false;
    digest = prf === 0 ? "sha1" : prf === 1 ? "sha256" : "sha512";
    salt = value.subarray(13, 13 + saltLength);
    expected = value.subarray(13 + saltLength);
  } else if (value.length === 49 && value[0] === 0) {
    iterations = 1_000;
    digest = "sha1";
    salt = value.subarray(1, 17);
    expected = value.subarray(17);
  } else {
    return false;
  }

  const actual = pbkdf2Sync(password, salt, iterations, expected.length, digest);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
