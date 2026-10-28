import type { Product, ProductDraft, ProductPage } from "./types";

const API_BASE_URL = (window.productCatalogConfig?.apiBaseUrl ?? "").replace(
  /\/+$/,
  "",
);

async function request<T>(
  path: string,
  options?: RequestInit,
): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, options);
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

    throw new Error(message);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

export function listProducts(
  query: URLSearchParams,
  signal?: AbortSignal,
): Promise<ProductPage> {
  return request<ProductPage>(`/api/products?${query}`, { signal });
}

export function saveProduct(
  draft: ProductDraft,
  id?: string,
): Promise<Product> {
  const body = {
    ...draft,
    price: Number(draft.price),
    stock: Number(draft.stock),
  };

  return request<Product>(id ? `/api/products/${id}` : "/api/products", {
    method: id ? "PUT" : "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function uploadImages(
  productId: string,
  files: File[],
): Promise<void> {
  const form = new FormData();
  for (const file of files) {
    form.append("files", file);
  }

  await request(`/api/products/${productId}/images`, {
    method: "POST",
    body: form,
  });
}

export function removeImage(productId: string, imageId: string): Promise<void> {
  return request(`/api/products/${productId}/images/${imageId}`, {
    method: "DELETE",
  });
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
