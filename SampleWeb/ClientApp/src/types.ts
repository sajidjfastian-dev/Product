export interface ProductImage {
  id: string;
  fileName: string;
  contentType: string;
  sortOrder: number;
}

export interface Product {
  id: string;
  name: string;
  category: string;
  price: number;
  stock: number;
  barcode: string | null;
  sku: string | null;
  description: string | null;
  location: string | null;
  brand: string | null;
  createdAtUtc: string;
  images: ProductImage[];
}

export interface ProductPage {
  items: Product[];
  totalCount: number;
  page: number;
  pageSize: number;
}

export interface ProductDraft {
  name: string;
  category: string;
  price: string;
  stock: string;
  barcode: string;
  sku: string;
  description: string;
  location: string;
  brand: string;
}

declare global {
  interface Window {
    productCatalogConfig?: {
      apiBaseUrl?: string;
    };
  }
}
