import type {
  AuthUser,
  DashboardData,
  CustomerAssistantReply,
  CustomerProduct,
  Product,
  ProductDraft,
  ProductPage,
  UserSummary,
} from "./types";

const API_BASE_URL = (window.productCatalogConfig?.apiBaseUrl ?? "").replace(
  /\/+$/,
  "",
);

class ApiError extends Error {
  readonly status: number;

  constructor(
    message: string,
    status: number,
  ) {
    super(message);
    this.status = status;
  }
}

let csrfToken = "";

async function refreshCsrfToken(): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/api/auth/csrf`, {
    credentials: "include",
  });
  if (!response.ok) throw new ApiError("Could not start a secure session.", response.status);
  const body = (await response.json()) as { requestToken: string };
  csrfToken = body.requestToken;
}

async function request<T>(
  path: string,
  options?: RequestInit,
): Promise<T> {
  const method = options?.method?.toUpperCase() ?? "GET";
  const changesState = !["GET", "HEAD", "OPTIONS", "TRACE"].includes(method);
  if (changesState && !csrfToken) await refreshCsrfToken();

  const headers = new Headers(options?.headers);
  if (changesState) headers.set("X-CSRF-TOKEN", csrfToken);
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers,
    credentials: "include",
  });

  if (!response.ok) {
    let message = `Request failed (${response.status}).`;
    try {
      const body = (await response.json()) as {
        errors?: Record<string, string[]>;
        message?: string;
        title?: string;
      };
      message = body.errors
        ? Object.values(body.errors).flat().join(" ")
        : (body.message ?? body.title ?? message);
    } catch {
      // Retain the HTTP status when the server does not return JSON.
    }

    throw new ApiError(message, response.status);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export function getAuthStatus(): Promise<{ setupRequired: boolean }> {
  return request("/api/auth/status");
}

export async function getCurrentUser(): Promise<AuthUser | null> {
  try {
    return await request<AuthUser>("/api/auth/me");
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
}

export async function signIn(email: string, password: string): Promise<AuthUser> {
  const user = await request<AuthUser>("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  await refreshCsrfToken();
  return user;
}

export async function bootstrapAdmin(
  email: string,
  displayName: string,
  password: string,
): Promise<AuthUser> {
  const user = await request<AuthUser>("/api/auth/bootstrap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, displayName, password }),
  });
  await refreshCsrfToken();
  return user;
}

export async function signOut(): Promise<void> {
  await request("/api/auth/logout", { method: "POST" });
  csrfToken = "";
}

export function getDashboard(signal?: AbortSignal): Promise<DashboardData> {
  return request("/api/reports/dashboard", { signal });
}

export function adjustInventory(input: {
  productId: string;
  quantityChange: number;
  reason: string;
  reference: string;
}): Promise<unknown> {
  return request("/api/inventory/adjustments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export function listUsers(): Promise<UserSummary[]> {
  return request("/api/auth/admin/users");
}

export function listRoles(): Promise<{ roles: Array<{ name: string; permissions: string[] }> }> {
  return request("/api/auth/admin/roles");
}

export function createUser(input: {
  email: string;
  displayName: string;
  temporaryPassword: string;
  roles: string[];
}): Promise<unknown> {
  return request("/api/auth/admin/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export function updateUserRoles(id: string, roles: string[]): Promise<void> {
  return request(`/api/auth/admin/users/${id}/roles`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ roles }),
  });
}

export function setUserActive(id: string, isActive: boolean): Promise<void> {
  return request(`/api/auth/admin/users/${id}/active`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ isActive }),
  });
}

export function listProducts(
  query: URLSearchParams,
  signal?: AbortSignal,
): Promise<ProductPage> {
  return request<ProductPage>(`/api/products?${query}`, { signal });
}

export function listCustomerProducts(query: URLSearchParams, signal?: AbortSignal): Promise<{
  items: CustomerProduct[];
  categories: string[];
}> {
  return request(`/api/store/products?${query}`, { signal });
}

export function getCustomerProduct(identifier: string, signal?: AbortSignal): Promise<CustomerProduct> {
  return request(`/api/store/products/${encodeURIComponent(identifier)}`, { signal });
}

export function sendCustomerChat(messages: Array<{ role: "user" | "assistant"; content: string }>): Promise<CustomerAssistantReply> {
  return request("/api/customer-assistant/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages }),
  });
}

export function customerImageUrl(productId: string, imageId: string): string {
  return `${API_BASE_URL}/api/store/products/${encodeURIComponent(productId)}/images/${encodeURIComponent(imageId)}`;
}

export function saveProduct(
  draft: ProductDraft,
  id?: string,
): Promise<Product> {
  const body = {
    ...draft,
    price: Number(draft.price),
    stock: Number(draft.stock),
    reorderLevel: Number(draft.reorderLevel),
  };

  return request<Product>(id ? `/api/products/${id}` : "/api/products", {
    method: id ? "PUT" : "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function uploadImages(productId: string, files: File[]): Promise<void> {
  const form = new FormData();
  for (const file of files) form.append("files", file);
  await request(`/api/products/${productId}/images`, { method: "POST", body: form });
}

export function removeImage(productId: string, imageId: string): Promise<void> {
  return request(`/api/products/${productId}/images/${imageId}`, { method: "DELETE" });
}

export function deleteProduct(productId: string): Promise<void> {
  return request(`/api/products/${productId}`, { method: "DELETE" });
}

export function imageUrl(productId: string, imageId: string): string {
  return `${API_BASE_URL}/api/products/${productId}/images/${imageId}`;
}

export function pdfUrl(): string {
  return `${API_BASE_URL}/api/products/pdf`;
}

export function inventoryReportUrl(): string {
  return `${API_BASE_URL}/api/reports/inventory.csv`;
}

export function movementReportUrl(): string {
  return `${API_BASE_URL}/api/reports/movements.csv`;
}

export interface SaleSummary {
  id: string;
  reference: string;
  customerName: string | null;
  subtotal: number;
  discountPercent: number;
  discountAmount: number;
  total: number;
  itemCount: number;
  createdAtUtc: string;
}

export interface PurchaseSummary {
  id: string;
  reference: string;
  supplierName: string | null;
  total: number;
  createdAtUtc: string;
}

export function createSale(input: {
  customerName: string;
  discountPercent: number;
  items: Array<{ productId: string; quantity: number; discountPercent: number }>;
}): Promise<{ id: string; reference: string; total: number; discountAmount: number }> {
  return request("/api/sales", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export function getSales(): Promise<SaleSummary[]> {
  return request("/api/sales");
}

export function createPurchase(input: {
  supplierName: string;
  items: Array<{ productId: string; quantity: number; unitCost: number }>;
}): Promise<{ id: string; reference: string; total: number }> {
  return request("/api/purchases", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export function getPurchases(): Promise<PurchaseSummary[]> {
  return request("/api/purchases");
}
