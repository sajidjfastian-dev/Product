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
  reorderLevel: number;
  barcode: string | null;
  sku: string | null;
  description: string | null;
  location: string | null;
  brand: string | null;
  createdAtUtc: string;
  images: ProductImage[];
}

export interface CustomerProduct {
  id: string;
  name: string;
  category: string;
  brand: string | null;
  description: string | null;
  sku: string | null;
  price: number;
  stock: number;
  imageId: string | null;
}

export type CustomerRoute =
  | "product_detail"
  | "category_listing"
  | "cart"
  | "checkout"
  | "order_status"
  | "stay_on_chat";

export interface CustomerAssistantReply {
  customer_facing_message: string;
  routing_action: {
    target_page: CustomerRoute;
    payload: {
      search_query: string | null;
      product_id_or_slug: string | null;
      category_name: string | null;
    };
  };
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
  reorderLevel: string;
  barcode: string;
  sku: string;
  description: string;
  location: string;
  brand: string;
}

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  roles: string[];
  permissions: string[];
}

export interface DashboardData {
  productCount: number;
  unitsOnHand: number;
  inventoryRetailValue: number;
  lowStockCount: number;
  outOfStockCount: number;
  bestSellingItems: Array<{
    id: string;
    name: string;
    unitsSold: number;
    revenue: number;
  }>;
  lowStock: Array<{
    id: string;
    name: string;
    sku: string | null;
    stock: number;
    reorderLevel: number;
    price: number;
  }>;
  movementTrend: Array<{
    date: string;
    received: number;
    issued: number;
    transactions: number;
  }>;
  recentMovements: InventoryMovement[];
}

export interface InventoryMovement {
  id: string;
  productId: string;
  productName: string;
  sku: string | null;
  movementType: string;
  quantityChange: number;
  balanceAfter: number;
  reason: string;
  reference: string | null;
  createdByEmail: string | null;
  createdAtUtc: string;
}

export interface UserSummary {
  id: string;
  email: string;
  displayName: string;
  isActive: boolean;
  createdAtUtc: string;
  lastLoginAtUtc: string | null;
  roles: string[];
}

declare global {
  interface Window {
    productCatalogConfig?: {
      apiBaseUrl?: string;
    };
  }
}
