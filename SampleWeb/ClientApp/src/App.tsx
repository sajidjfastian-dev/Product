import {
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import JsBarcode from "jsbarcode";
import CustomerStorefront from "./CustomerStorefront";
import {
  adjustInventory,
  bootstrapAdmin,
  createUser,
  deleteProduct,
  getAuthStatus,
  getCurrentUser,
  getDashboard,
  imageUrl,
  inventoryReportUrl,
  listProducts,
  listRoles,
  listUsers,
  movementReportUrl,
  pdfUrl,
  removeImage,
  saveProduct,
  setUserActive,
  signIn,
  signOut,
  updateUserRoles,
  uploadImages,
} from "./api";
import OrderWorkspace from "./OrderWorkspace";
import type { AuthUser, DashboardData, Product, ProductDraft, ProductImage, UserSummary } from "./types";

const PAGE_SIZE_OPTIONS = [10, 20, 50];
const MAX_IMAGES = 8;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];

const blankDraft: ProductDraft = {
  name: "",
  category: "",
  price: "",
  stock: "",
  reorderLevel: "10",
  barcode: "",
  sku: "",
  description: "",
  location: "",
  brand: "",
};

type SortField =
  | "name"
  | "sku"
  | "barcode"
  | "category"
  | "brand"
  | "location"
  | "price"
  | "stock";

function toDraft(product: Product): ProductDraft {
  return {
    name: product.name,
    category: product.category,
    price: String(product.price),
    stock: String(product.stock),
    reorderLevel: String(product.reorderLevel),
    barcode: product.barcode ?? "",
    sku: product.sku ?? "",
    description: product.description ?? "",
    location: product.location ?? "",
    brand: product.brand ?? "",
  };
}

function LocalPreview({ file }: { file: File }) {
  const [url, setUrl] = useState("");

  useEffect(() => {
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);

  return url ? <img src={url} alt="" /> : <div className="image-placeholder" />;
}

function App() {
  if (window.location.pathname === "/shop" || window.location.pathname.startsWith("/shop/")) {
    return <CustomerStorefront />;
  }
  return <AdminApp />;
}

function AdminApp() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [authState, setAuthState] = useState<"loading" | "setup" | "login" | "ready">("loading");
  const [authError, setAuthError] = useState("");

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const status = await getAuthStatus();
        if (!active) return;
        if (status.setupRequired) {
          setAuthState("setup");
          return;
        }

        const currentUser = await getCurrentUser();
        if (!active) return;
        setUser(currentUser);
        setAuthState(currentUser ? "ready" : "login");
      } catch (loadError) {
        if (!active) return;
        setAuthError(loadError instanceof Error ? loadError.message : "Could not connect to the inventory service.");
        setAuthState("login");
      }
    })();

    return () => {
      active = false;
    };
  }, []);

  const authenticate = async (email: string, password: string, displayName?: string): Promise<void> => {
    setAuthError("");
    try {
      const authenticated = displayName
        ? await bootstrapAdmin(email, displayName, password)
        : await signIn(email, password);
      setUser(authenticated);
      setAuthState("ready");
    } catch (authFailure) {
      setAuthError(authFailure instanceof Error ? authFailure.message : "Sign-in failed.");
    }
  };

  const handleSignOut = async () => {
    try {
      await signOut();
      setUser(null);
      setAuthState("login");
    } catch (signOutError) {
      setAuthError(signOutError instanceof Error ? signOutError.message : "Sign-out failed.");
    }
  };

  if (authState === "loading") {
    return <div className="auth-page"><div className="auth-card">Connecting securely to Stockroom…</div></div>;
  }

  if (authState !== "ready" || !user) {
    return (
      <AuthScreen
        mode={authState === "setup" ? "setup" : "login"}
        error={authError}
        onSubmit={(email, password, displayName) => authenticate(email, password, displayName)}
      />
    );
  }

  return <CatalogApp user={user} onSignOut={() => void handleSignOut()} />;
}

function CatalogApp({ user, onSignOut }: { user: AuthUser; onSignOut: () => void }) {
  type TabKey = "overview" | "products" | "sales" | "purchases" | "inventory" | "reports" | "team";
  const [activeTab, setActiveTab] = useState<TabKey>(
    user.permissions.includes("reports.read") ? "overview" : "products",
  );
  const [productPage, setProductPage] = useState({
    items: [] as Product[],
    totalCount: 0,
    page: 1,
    pageSize: 10,
  });
  const [draft, setDraft] = useState<ProductDraft>(blankDraft);
  const [editing, setEditing] = useState<Product | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [brand, setBrand] = useState("");
  const [location, setLocation] = useState("");
  const [stock, setStock] = useState("");
  const [minPrice, setMinPrice] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [sortBy, setSortBy] = useState<SortField>("name");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [dashboardError, setDashboardError] = useState("");
  const [adjusting, setAdjusting] = useState(false);
  const [adjustmentProductId, setAdjustmentProductId] = useState("");
  const [adjustmentQuantity, setAdjustmentQuantity] = useState("");
  const [adjustmentReason, setAdjustmentReason] = useState("");
  const [adjustmentReference, setAdjustmentReference] = useState("");

  const loadProducts = useCallback(
    async (signal?: AbortSignal) => {
      const query = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
        sortBy,
        sortDirection,
      });
      if (search.trim()) query.set("search", search.trim());
      if (category.trim()) query.set("category", category.trim());
      if (brand.trim()) query.set("brand", brand.trim());
      if (location.trim()) query.set("location", location.trim());
      if (stock) query.set("stock", stock);
      if (minPrice) query.set("minPrice", minPrice);
      if (maxPrice) query.set("maxPrice", maxPrice);

      const result = await listProducts(query, signal);
      setProductPage(result);
      const pageCount = Math.max(1, Math.ceil(result.totalCount / result.pageSize));
      if (page > pageCount) setPage(pageCount);
    },
    [
      page,
      pageSize,
      sortBy,
      sortDirection,
      search,
      category,
      brand,
      location,
      stock,
      minPrice,
      maxPrice,
    ],
  );

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      loadProducts(controller.signal).catch((loadError: unknown) => {
        if (loadError instanceof DOMException && loadError.name === "AbortError") {
          return;
        }
        setError(loadError instanceof Error ? loadError.message : "Could not load products.");
      });
    }, search ? 220 : 0);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [loadProducts, search]);

  useEffect(() => {
    if (!user.permissions.includes("reports.read")) return;
    const controller = new AbortController();
    getDashboard(controller.signal)
      .then(setDashboard)
      .catch((loadError: unknown) => {
        if (loadError instanceof DOMException && loadError.name === "AbortError") return;
        setDashboardError(loadError instanceof Error ? loadError.message : "Could not load dashboard.");
      });
    return () => controller.abort();
  }, [user.id, user.permissions]);

  const pageCount = Math.max(
    1,
    Math.ceil(productPage.totalCount / productPage.pageSize),
  );
  const selectedImageCount = editing?.images.length ?? 0;
  const availableSlots = MAX_IMAGES - selectedImageCount - selectedFiles.length;
  const clearFiltersVisible = Boolean(
    search || category || brand || location || stock || minPrice || maxPrice,
  );

  const updateDraft = (
    event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => {
    setDraft((current) => ({ ...current, [event.target.name]: event.target.value }));
  };

  const pickFiles = (fileList: FileList | File[]) => {
    const incoming = Array.from(fileList);
    if (incoming.length === 0) return;

    const remaining = MAX_IMAGES - (editing?.images.length ?? 0) - selectedFiles.length;
    if (incoming.length > remaining) {
      setError(`There is room for ${Math.max(remaining, 0)} more image(s).`);
      return;
    }

    const invalid = incoming.find(
      (file) =>
        !ALLOWED_IMAGE_TYPES.includes(file.type) ||
        file.size === 0 ||
        file.size > MAX_IMAGE_BYTES,
    );
    if (invalid) {
      setError(
        `${invalid.name} is not a supported image. Use JPEG, PNG, or WebP up to 8 MB.`,
      );
      return;
    }

    setError("");
    setSelectedFiles((current) => [...current, ...incoming]);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    pickFiles(event.dataTransfer.files);
  };

  const startCreate = () => {
    setEditing(null);
    setDraft(blankDraft);
    setSelectedFiles([]);
    setMessage("");
    setError("");
  };

  const startEdit = (product: Product) => {
    setEditing(product);
    setDraft(toDraft(product));
    setSelectedFiles([]);
    setMessage("");
    setError("");
    document.querySelector("#product-editor")?.scrollIntoView({ behavior: "smooth" });
  };

  const refreshAfterSave = async () => {
    await loadProducts();
    if (user.permissions.includes("reports.read")) {
      setDashboard(await getDashboard());
    }
  };

  const submitProduct = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    setError("");

    try {
      const wasEditing = editing !== null;
      const product = await saveProduct(draft, editing?.id);
      if (!wasEditing) {
        setEditing(product);
        setDraft(toDraft(product));
      }

      if (selectedFiles.length > 0) {
        await uploadImages(product.id, selectedFiles);
      }

      setEditing(null);
      setDraft(blankDraft);
      setSelectedFiles([]);
      setMessage(wasEditing ? "Product updated." : "Product added.");
      await refreshAfterSave();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not save product.");
      await refreshAfterSave();
    } finally {
      setBusy(false);
    }
  };

  const removeProduct = async (product: Product) => {
    if (!window.confirm(`Delete "${product.name}" and its images?`)) return;

    setError("");
    try {
      await deleteProduct(product.id);
      if (editing?.id === product.id) startCreate();
      await loadProducts();
      setMessage(`${product.name} deleted.`);
      if (user.permissions.includes("reports.read")) setDashboard(await getDashboard());
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Could not delete product.");
    }
  };

  const submitAdjustment = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await adjustInventory({
        productId: adjustmentProductId,
        quantityChange: Number(adjustmentQuantity),
        reason: adjustmentReason,
        reference: adjustmentReference,
      });
      setAdjustmentQuantity("");
      setAdjustmentReason("");
      setAdjustmentReference("");
      setAdjusting(false);
      await loadProducts();
      if (user.permissions.includes("reports.read")) setDashboard(await getDashboard());
      setMessage("Inventory adjustment recorded.");
    } catch (adjustError) {
      setError(adjustError instanceof Error ? adjustError.message : "Could not adjust inventory.");
    } finally {
      setBusy(false);
    }
  };

  const removeExistingImage = async (image: ProductImage) => {
    if (!editing) return;
    setError("");
    try {
      await removeImage(editing.id, image.id);
      setEditing((current) =>
        current
          ? { ...current, images: current.images.filter((item) => item.id !== image.id) }
          : current,
      );
      await loadProducts();
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : "Could not remove image.");
    }
  };

  const changeSort = (field: SortField) => {
    if (sortBy === field) {
      setSortDirection((current) => (current === "asc" ? "desc" : "asc"));
    } else {
      setSortBy(field);
      setSortDirection("asc");
    }
    setPage(1);
  };

  const resetFilters = () => {
    setSearch("");
    setCategory("");
    setBrand("");
    setLocation("");
    setStock("");
    setMinPrice("");
    setMaxPrice("");
    setPage(1);
  };

  const productRows = productPage.items.map((product) => (
        <tr key={product.id}>
          <td className="product-cell">
            <div className="product-identity">
              <ProductThumbnail product={product} />
              <div className="product-name-wrap">
                <strong>{product.name}</strong>
                <span>{product.description || "No description"}</span>
              </div>
            </div>
          </td>
          <td className="mono">{product.sku || <span className="muted">—</span>}</td>
          <td className="barcode-cell">
            <span className="mono">{product.barcode || <span className="muted">—</span>}</span>
            {product.barcode && <BarcodeLabel value={product.barcode} />}
          </td>
          <td><span className="category-pill">{product.category}</span></td>
          <td>{product.brand || <span className="muted">—</span>}</td>
          <td>{product.location || <span className="muted">—</span>}</td>
          <td className="number-cell">${product.price.toFixed(2)}</td>
          <td>
            <span className={`stock-pill ${product.stock === 0 ? "stock-empty" : product.stock < 10 ? "stock-low" : ""}`}>
              {product.stock === 0 ? "Out of stock" : `${product.stock} in stock`}
            </span>
          </td>
          <td className="row-actions">
            {user.permissions.includes("products.write") && <>
              <button className="icon-button" type="button" aria-label={`Edit ${product.name}`} onClick={() => startEdit(product)}>Edit</button>
              <button className="icon-button danger-action" type="button" aria-label={`Archive ${product.name}`} onClick={() => void removeProduct(product)}>Archive</button>
            </>}
          </td>
        </tr>
  ));

  const availableTabs: Array<{ id: TabKey; label: string; permission: string }> = [
    { id: "overview", label: "Overview", permission: "reports.read" },
    { id: "products", label: "Products", permission: "products.read" },
    { id: "sales", label: "Sales", permission: "sales.manage" },
    { id: "purchases", label: "Purchases", permission: "purchases.manage" },
    { id: "inventory", label: "Inventory", permission: "inventory.read" },
    { id: "reports", label: "Reports", permission: "reports.read" },
    { id: "team", label: "Team", permission: "users.manage" },
  ];
  const tabs = availableTabs.filter((tab) => user.permissions.includes(tab.permission));

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand-lockup" href="/" aria-label="Stockroom home">
          <span className="brand-mark">S</span>
          <span className="brand-copy"><strong>stockroom</strong><small>PRODUCT OPERATIONS</small></span>
        </a>
        <div className="topbar-actions">
          <span className="connection-status"><i /> SQL SERVER CONNECTED</span>
          {user.permissions.includes("reports.read") && <a className="button button-outline" href={pdfUrl()} target="_blank" rel="noreferrer">Export PDF <span aria-hidden="true">↗</span></a>}
          <span className="signed-in-user">{user.displayName} · {user.roles[0]}</span>
          <button className="button button-outline" type="button" onClick={onSignOut}>Sign out</button>
          {user.permissions.includes("products.write") && <button className="button button-primary" type="button" onClick={() => { setActiveTab("products"); startCreate(); }}><span aria-hidden="true">＋</span> Add product</button>}
        </div>
      </header>

      <nav className="workspace-tabs" role="tablist" aria-label="Inventory workspace">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            id={`tab-${tab.id}`}
            aria-controls="workspace-panel"
            aria-selected={activeTab === tab.id}
            className={`workspace-tab ${activeTab === tab.id ? "workspace-tab-active" : ""}`}
            onClick={() => setActiveTab(tab.id)}
            role="tab"
            tabIndex={activeTab === tab.id ? 0 : -1}
            type="button"
          >
            {tab.label}
          </button>
        ))}
      </nav>
      <div id="workspace-panel" className="workspace-panel" role="tabpanel" aria-labelledby={`tab-${activeTab}`} tabIndex={0}>
      {message && <div className="notice notice-success" role="status">{message}<button type="button" onClick={() => setMessage("")} aria-label="Dismiss message">×</button></div>}
      {error && <div className="notice notice-error" role="alert">{error}<button type="button" onClick={() => setError("")} aria-label="Dismiss error">×</button></div>}

      {activeTab === "overview" && dashboard && (
        <DashboardPanel
          dashboard={dashboard}
          permissions={user.permissions}
          onAdjust={() => {
            setAdjustmentProductId(productPage.items[0]?.id ?? "");
            setAdjusting(true);
          }}
        />
      )}
      {dashboardError && <div className="notice notice-error" role="alert">{dashboardError}</div>}
      {activeTab === "inventory" && user.permissions.includes("inventory.adjust") && !adjusting && (
        <section className="workspace-page">
          <div className="page-intro"><div><p className="eyebrow">STOCK CONTROL</p><h1>Inventory</h1><p className="intro-copy">Record a traceable stock correction. Sales and received purchases update stock automatically.</p></div></div>
          <section className="enterprise-card">
            <div className="catalog-heading"><div><p className="eyebrow">MANUAL CORRECTION</p><h2>Adjust on-hand quantity</h2></div></div>
            <button type="button" className="button button-primary" onClick={() => {
              setAdjustmentProductId(productPage.items[0]?.id ?? "");
              setAdjusting(true);
            }}>Start adjustment</button>
          </section>
          {dashboard && <DashboardPanel dashboard={dashboard} permissions={user.permissions} onAdjust={() => setAdjusting(true)} />}
        </section>
      )}
      {activeTab === "inventory" && adjusting && user.permissions.includes("inventory.adjust") && (
        <section className="enterprise-card">
          <div className="catalog-heading">
            <div><p className="eyebrow">STOCK CONTROL</p><h2>Record an inventory adjustment</h2></div>
            <button type="button" className="text-button" onClick={() => setAdjusting(false)}>Cancel ×</button>
          </div>
          <form className="adjustment-form" onSubmit={(event) => void submitAdjustment(event)}>
            <label>Product<select required value={adjustmentProductId} onChange={(event) => setAdjustmentProductId(event.target.value)}>{productPage.items.map(product => <option key={product.id} value={product.id}>{product.name} · on hand {product.stock}</option>)}</select></label>
            <label>Quantity change<input required type="number" step="1" value={adjustmentQuantity} onChange={(event) => setAdjustmentQuantity(event.target.value)} placeholder="e.g. 5 or -2" /></label>
            <label>Reason<input required maxLength={300} value={adjustmentReason} onChange={(event) => setAdjustmentReason(event.target.value)} placeholder="Count correction, damaged goods…" /></label>
            <label>Reference<input maxLength={120} value={adjustmentReference} onChange={(event) => setAdjustmentReference(event.target.value)} placeholder="Optional reference" /></label>
            <button className="button button-primary" disabled={busy || productPage.items.length === 0} type="submit">Post adjustment</button>
          </form>
        </section>
      )}
      {activeTab === "team" && user.permissions.includes("users.manage") && <UserAdminPanel />}
      {activeTab === "sales" && <OrderWorkspace mode="sales" onComplete={refreshAfterSave} />}
      {activeTab === "purchases" && <OrderWorkspace mode="purchases" onComplete={refreshAfterSave} />}
      {activeTab === "reports" && <ReportsWorkspace dashboard={dashboard} />}

      {activeTab === "products" && <>
      <section className="page-intro">
        <div>
          <p className="eyebrow">INVENTORY OVERVIEW</p>
          <h1>Products <span className="product-total">{productPage.totalCount}</span></h1>
          <p className="intro-copy">A clear view of your catalog, stock levels, and product details.</p>
        </div>
        <div className="intro-decoration" aria-hidden="true"><span>01</span><i /><span>CATALOG</span></div>
      </section>

      {user.permissions.includes("products.write") && <section className="editor-card" id="product-editor">
        <div className="editor-heading">
          <div className="editor-title">
            <span className="section-index">{editing ? "02" : "01"}</span>
            <div><p className="eyebrow">{editing ? "UPDATE ITEM" : "NEW CATALOG ITEM"}</p><h2>{editing ? "Edit product" : "Add a product"}</h2></div>
          </div>
          {editing && <button className="text-button" type="button" onClick={startCreate}>Cancel editing <span>×</span></button>}
        </div>

        <form onSubmit={(event) => void submitProduct(event)}>
          <div className="editor-layout">
            <div className="fields-grid">
              <Field label="Product name" required><input autoComplete="off" maxLength={120} name="name" onChange={updateDraft} placeholder="e.g. Wireless Mouse" required value={draft.name} /></Field>
              <Field label="Category" required><input maxLength={80} name="category" onChange={updateDraft} placeholder="e.g. Accessories" required value={draft.category} /></Field>
              <Field label="Barcode"><input autoComplete="off" maxLength={64} name="barcode" onChange={updateDraft} placeholder="Auto-generated if blank" value={draft.barcode} /><small className="field-note">Code 128 barcode generated automatically when blank.</small></Field>
              <Field label="SKU"><input autoComplete="off" maxLength={64} name="sku" onChange={updateDraft} placeholder="e.g. ACC-MOUSE-001" value={draft.sku} /></Field>
              <Field label="Brand"><input maxLength={120} name="brand" onChange={updateDraft} placeholder="Brand name" value={draft.brand} /></Field>
              <Field label="Storage location"><input maxLength={120} name="location" onChange={updateDraft} placeholder="e.g. Aisle A / Shelf 1" value={draft.location} /></Field>
              <Field label="Unit price" required><div className="input-prefix"><span>$</span><input min="0" name="price" onChange={updateDraft} placeholder="0.00" required step="0.01" type="number" value={draft.price} /></div></Field>
              <Field label="Quantity in stock" required><input min="0" name="stock" onChange={updateDraft} placeholder="0" required step="1" type="number" value={draft.stock} /></Field>
              <Field label="Reorder level" required><input min="0" name="reorderLevel" onChange={updateDraft} required step="1" type="number" value={draft.reorderLevel} /></Field>
              <Field className="description-field" label="Description"><textarea maxLength={2000} name="description" onChange={updateDraft} placeholder="Add product details, specifications, or notes…" rows={3} value={draft.description} /></Field>
            </div>
            <ImageDropzone
              dragging={dragging}
              editing={editing}
              files={selectedFiles}
              onDragEnter={() => setDragging(true)}
              onDragLeave={() => setDragging(false)}
              onDrop={handleDrop}
              onFiles={pickFiles}
              onRemoveExisting={(image) => void removeExistingImage(image)}
              onRemovePending={(index) => setSelectedFiles((current) => current.filter((_, itemIndex) => itemIndex !== index))}
              remaining={Math.max(availableSlots, 0)}
            />
          </div>

          <div className="form-footer">
            <p className="form-hint"><span className="required-dot">*</span> Required fields <span className="form-divider">·</span> SKU and barcode must be unique</p>
            <button className="button button-primary save-button" disabled={busy} type="submit">{busy ? "Saving…" : editing ? "Save changes" : "Create product"} <span aria-hidden="true">→</span></button>
          </div>
        </form>
      </section>}

      <section className="catalog-section">
        <div className="catalog-heading">
          <div><p className="eyebrow">YOUR INVENTORY</p><h2>Product catalog</h2></div>
          <div className="result-count">{productPage.totalCount} {productPage.totalCount === 1 ? "item" : "items"}</div>
        </div>

        <div className="filter-panel">
          <div className="search-field">
            <span aria-hidden="true">⌕</span>
            <input aria-label="Search products" onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder="Search name, barcode, SKU…" value={search} />
            {search && <button type="button" onClick={() => { setSearch(""); setPage(1); }} aria-label="Clear search">×</button>}
          </div>
          <input aria-label="Filter by category" onChange={(event) => { setCategory(event.target.value); setPage(1); }} placeholder="Category" value={category} />
          <input aria-label="Filter by brand" onChange={(event) => { setBrand(event.target.value); setPage(1); }} placeholder="Brand" value={brand} />
          <input aria-label="Filter by location" onChange={(event) => { setLocation(event.target.value); setPage(1); }} placeholder="Location" value={location} />
          <select aria-label="Filter stock" onChange={(event) => { setStock(event.target.value); setPage(1); }} value={stock}>
            <option value="">All stock</option><option value="in">In stock</option><option value="out">Out of stock</option>
          </select>
          <div className="price-filter"><span>$</span><input aria-label="Minimum price" min="0" onChange={(event) => { setMinPrice(event.target.value); setPage(1); }} placeholder="Min" type="number" value={minPrice} /><i /> <span>$</span><input aria-label="Maximum price" min="0" onChange={(event) => { setMaxPrice(event.target.value); setPage(1); }} placeholder="Max" type="number" value={maxPrice} /></div>
          {clearFiltersVisible && <button className="clear-filter" type="button" onClick={resetFilters}>Clear filters <span>×</span></button>}
        </div>

        <div className="table-card">
          <div className="table-scroll">
            <table className="product-table">
              <thead><tr>
                <SortableHeader field="name" label="Product" current={sortBy} direction={sortDirection} onSort={changeSort} />
                <SortableHeader field="sku" label="SKU" current={sortBy} direction={sortDirection} onSort={changeSort} />
                <SortableHeader field="barcode" label="Barcode" current={sortBy} direction={sortDirection} onSort={changeSort} />
                <SortableHeader field="category" label="Category" current={sortBy} direction={sortDirection} onSort={changeSort} />
                <SortableHeader field="brand" label="Brand" current={sortBy} direction={sortDirection} onSort={changeSort} />
                <SortableHeader field="location" label="Location" current={sortBy} direction={sortDirection} onSort={changeSort} />
                <SortableHeader field="price" label="Price" current={sortBy} direction={sortDirection} onSort={changeSort} />
                <SortableHeader field="stock" label="Stock" current={sortBy} direction={sortDirection} onSort={changeSort} />
                <th scope="col"><span className="sr-only">Actions</span></th>
              </tr></thead>
              <tbody>{productRows}</tbody>
            </table>
            {productPage.items.length === 0 && <div className="empty-state"><span>⌕</span><strong>No products found</strong><p>Try changing your search or filters.</p>{clearFiltersVisible && <button className="text-button" type="button" onClick={resetFilters}>Clear all filters</button>}</div>}
          </div>
          <div className="pagination">
            <span>Showing <strong>{productPage.totalCount === 0 ? 0 : (page - 1) * pageSize + 1}–{Math.min(page * pageSize, productPage.totalCount)}</strong> of <strong>{productPage.totalCount}</strong></span>
            <div className="pagination-controls">
              <label>Rows <select aria-label="Rows per page" onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1); }} value={pageSize}>{PAGE_SIZE_OPTIONS.map((size) => <option key={size} value={size}>{size}</option>)}</select></label>
              <button type="button" aria-label="Previous page" disabled={page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))}>←</button>
              <span className="page-number">{page} <span>/</span> {pageCount}</span>
              <button type="button" aria-label="Next page" disabled={page >= pageCount} onClick={() => setPage((current) => Math.min(pageCount, current + 1))}>→</button>
            </div>
          </div>
        </div>
      </section>
      </>}

      <footer className="app-footer"><span>STOCKROOM <i>·</i> PRODUCT OPERATIONS</span><span>IMAGES STORED SECURELY IN SQL SERVER</span></footer>
      </div>
    </main>
  );
}

function AuthScreen({
  mode,
  error,
  onSubmit,
}: {
  mode: "setup" | "login";
  error: string;
  onSubmit: (email: string, password: string, displayName?: string) => Promise<void>;
}) {
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    void onSubmit(email, password, mode === "setup" ? displayName : undefined)
      .finally(() => setBusy(false));
  };

  return (
    <main className="auth-page">
      <form className="auth-card" onSubmit={submit}>
        <div className="brand-lockup">
          <span className="brand-mark">S</span>
          <span className="brand-copy"><strong>stockroom</strong><small>INVENTORY OPERATIONS</small></span>
        </div>
        <p className="eyebrow">{mode === "setup" ? "SECURE FIRST-RUN SETUP" : "SECURE WORKSPACE"}</p>
        <h1>{mode === "setup" ? "Create your administrator" : "Welcome back"}</h1>
        <p className="intro-copy">{mode === "setup" ? "This one-time setup creates the first administrator account. Use a unique password." : "Sign in with your Stockroom account to continue."}</p>
        {mode === "setup" && <label className="auth-field">Display name<input autoComplete="name" maxLength={120} required value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label>}
        <label className="auth-field">Email<input autoComplete="username" type="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label>
        <label className="auth-field">Password<input autoComplete={mode === "setup" ? "new-password" : "current-password"} minLength={mode === "setup" ? 12 : undefined} required type="password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
        {mode === "setup" && <small className="field-note">At least 12 characters with uppercase, lowercase, a number, and a symbol.</small>}
        {error && <div className="notice notice-error" role="alert">{error}</div>}
        <button className="button button-primary auth-submit" disabled={busy} type="submit">{busy ? "Please wait…" : mode === "setup" ? "Create administrator" : "Sign in"}</button>
      </form>
    </main>
  );
}

function DashboardPanel({
  dashboard,
  permissions,
  onAdjust,
}: {
  dashboard: DashboardData;
  permissions: string[];
  onAdjust: () => void;
}) {
  const maxMovement = Math.max(
    1,
    ...dashboard.movementTrend.map(day => Math.max(day.received, day.issued)),
  );

  return (
    <section className="dashboard">
      <div className="dashboard-heading">
        <div><p className="eyebrow">OPERATIONS AT A GLANCE</p><h1>Inventory dashboard</h1></div>
        <div className="report-actions">
          <a className="button button-outline" href={inventoryReportUrl()}>Inventory CSV</a>
          <a className="button button-outline" href={movementReportUrl()}>Movement CSV</a>
          {permissions.includes("inventory.adjust") && <button className="button button-primary" type="button" onClick={onAdjust}>Adjust stock</button>}
        </div>
      </div>
      <div className="metric-grid">
        <MetricCard label="Active products" value={dashboard.productCount.toLocaleString()} detail="Across this warehouse" />
        <MetricCard label="Units on hand" value={dashboard.unitsOnHand.toLocaleString()} detail="Current sellable quantity" />
        <MetricCard label="Retail stock value" value={`$${dashboard.inventoryRetailValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`} detail="Quantity × product price" />
        <MetricCard label="Needs attention" value={(dashboard.lowStockCount + dashboard.outOfStockCount).toLocaleString()} detail={`${dashboard.lowStockCount} low · ${dashboard.outOfStockCount} out of stock`} warning />
      </div>
      <div className="dashboard-grid">
        <section className="enterprise-card">
          <div className="catalog-heading"><div><p className="eyebrow">LAST 14 DAYS</p><h2>Stock movement</h2></div><span className="muted">Units received / issued</span></div>
          <div className="movement-chart" role="img" aria-label="Daily stock received and issued over the last 14 days">
            {dashboard.movementTrend.map(day => (
              <div className="chart-day" key={day.date} title={`${new Date(day.date).toLocaleDateString()}: +${day.received} / -${day.issued}`}>
                <div className="chart-bars">
                  <i className="chart-received" style={{ height: `${Math.max(day.received ? 4 : 0, (day.received / maxMovement) * 100)}%` }} />
                  <i className="chart-issued" style={{ height: `${Math.max(day.issued ? 4 : 0, (day.issued / maxMovement) * 100)}%` }} />
                </div>
                <small>{new Date(day.date).toLocaleDateString(undefined, { day: "numeric" })}</small>
              </div>
            ))}
          </div>
          <div className="chart-legend"><span><i className="chart-received" /> Received</span><span><i className="chart-issued" /> Issued</span></div>
        </section>
        <section className="enterprise-card">
          <div className="catalog-heading"><div><p className="eyebrow">REPLENISHMENT</p><h2>Low stock alerts</h2></div><span className="result-count">{dashboard.lowStockCount + dashboard.outOfStockCount} alerts</span></div>
          {dashboard.lowStock.length === 0 ? <p className="empty-copy">All products are above their reorder levels.</p> : (
            <div className="compact-list">
              {dashboard.lowStock.map(product => (
                <div className="compact-row" key={product.id}>
                  <span><strong>{product.name}</strong><small>{product.sku || "No SKU"} · reorder at {product.reorderLevel}</small></span>
                  <b className={product.stock === 0 ? "stock-empty" : "stock-low"}>{product.stock} left</b>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
      <section className="enterprise-card">
        <div className="catalog-heading"><div><p className="eyebrow">SALES PERFORMANCE</p><h2>Best-selling items</h2></div><span className="muted">Ranked by completed units sold</span></div>
        {dashboard.bestSellingItems.length === 0
          ? <p className="empty-copy">Completed sales will appear here as your team checks out products.</p>
          : <div className="compact-list">{dashboard.bestSellingItems.map((item, index) => (
            <div className="compact-row" key={item.id}>
              <span><strong><span className="seller-rank">{String(index + 1).padStart(2, "0")}</span>{item.name}</strong><small>{item.unitsSold.toLocaleString()} units sold</small></span>
              <b className="seller-revenue">${item.revenue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</b>
            </div>
          ))}</div>}
      </section>
      <section className="enterprise-card activity-card">
        <div className="catalog-heading"><div><p className="eyebrow">AUDITABLE OPERATIONS</p><h2>Recent inventory activity</h2></div><span className="muted">Opening balances and posted adjustments</span></div>
        {dashboard.recentMovements.length === 0 ? <p className="empty-copy">No inventory movements recorded yet.</p> : (
          <div className="table-scroll"><table className="activity-table"><thead><tr><th>Date</th><th>Product</th><th>Type</th><th>Change</th><th>Balance</th><th>Reason</th><th>User</th></tr></thead><tbody>
            {dashboard.recentMovements.map(movement => <tr key={movement.id}>
              <td>{new Date(movement.createdAtUtc).toLocaleString()}</td>
              <td><strong>{movement.productName}</strong><small>{movement.sku || ""}</small></td>
              <td>{movement.movementType}</td><td className={movement.quantityChange < 0 ? "stock-empty" : "stock-positive"}>{movement.quantityChange > 0 ? "+" : ""}{movement.quantityChange}</td>
              <td>{movement.balanceAfter}</td><td>{movement.reason}</td><td>{movement.createdByEmail || "System"}</td>
            </tr>)}
          </tbody></table></div>
        )}
      </section>
    </section>
  );
}

function ReportsWorkspace({ dashboard }: { dashboard: DashboardData | null }) {
  return (
    <section className="workspace-page">
      <div className="page-intro">
        <div><p className="eyebrow">INSIGHTS & EXPORTS</p><h1>Reports</h1><p className="intro-copy">Download inventory records and see which products are moving.</p></div>
      </div>
      <div className="report-card-grid">
        <article className="enterprise-card report-card">
          <p className="eyebrow">PRODUCT CATALOG</p><h2>Inventory snapshot</h2>
          <p className="intro-copy">Active products, current stock balances, reorder levels, and prices.</p>
          <a className="button button-outline" href={inventoryReportUrl()}>Download inventory CSV ↗</a>
        </article>
        <article className="enterprise-card report-card">
          <p className="eyebrow">STOCK LEDGER</p><h2>Movement history</h2>
          <p className="intro-copy">Opening balances, adjustments, completed sales, and received purchases.</p>
          <a className="button button-outline" href={movementReportUrl()}>Download movement CSV ↗</a>
        </article>
        <article className="enterprise-card report-card">
          <p className="eyebrow">PRINT & SHARE</p><h2>Product list PDF</h2>
          <p className="intro-copy">A printable, alphabetical list of active products and their stock.</p>
          <a className="button button-outline" href={pdfUrl()} target="_blank" rel="noreferrer">Open product PDF ↗</a>
        </article>
      </div>
      <section className="enterprise-card">
        <div className="catalog-heading"><div><p className="eyebrow">SALES PERFORMANCE</p><h2>Best-selling items</h2></div></div>
        {!dashboard?.bestSellingItems.length
          ? <p className="empty-copy">There are no completed sales to rank yet.</p>
          : <div className="table-scroll"><table className="activity-table"><thead><tr><th>Rank</th><th>Product</th><th>Units sold</th><th>Net item revenue</th></tr></thead><tbody>
            {dashboard.bestSellingItems.map((item, index) => <tr key={item.id}><td>{index + 1}</td><td><strong>{item.name}</strong></td><td>{item.unitsSold.toLocaleString()}</td><td>${item.revenue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td></tr>)}
          </tbody></table></div>}
      </section>
    </section>
  );
}

function MetricCard({ label, value, detail, warning = false }: { label: string; value: string; detail: string; warning?: boolean }) {
  return <article className={`metric-card ${warning ? "metric-warning" : ""}`}><span>{label}</span><strong>{value}</strong><small>{detail}</small></article>;
}

function BarcodeLabel({ value }: { value: string }) {
  const [expanded, setExpanded] = useState(false);
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    if (expanded && svgRef.current) {
      JsBarcode(svgRef.current, value, {
        format: "CODE128",
        width: 1.4,
        height: 38,
        displayValue: true,
        fontSize: 10,
        margin: 4,
      });
    }
  }, [expanded, value]);

  const printLabel = () => {
    if (!svgRef.current) return;
    const printWindow = window.open("", "_blank");
    if (!printWindow) return;
    printWindow.document.write(`<html><head><title>Barcode label</title><style>body{font-family:Arial,sans-serif;text-align:center;padding:24px}svg{max-width:100%}</style></head><body>${svgRef.current.outerHTML}<script>window.onload=()=>window.print()</script></body></html>`);
    printWindow.document.close();
  };

  return (
    <details className="barcode-label" onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary>Label</summary>
      <div><svg ref={svgRef} aria-label={`Code 128 barcode ${value}`} /><button type="button" className="text-button" onClick={printLabel}>Print label</button></div>
    </details>
  );
}

function UserAdminPanel() {
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [roles, setRoles] = useState<string[]>([]);
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [selectedRoles, setSelectedRoles] = useState<string[]>(["Warehouse Operator"]);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const reload = async () => {
    const [userRows, roleResponse] = await Promise.all([listUsers(), listRoles()]);
    setUsers(userRows);
    setRoles(roleResponse.roles.map(role => role.name));
  };

  useEffect(() => {
    void reload().catch(loadError => setError(loadError instanceof Error ? loadError.message : "Could not load users."));
  }, []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    setMessage("");
    try {
      await createUser({ email, displayName, temporaryPassword: password, roles: selectedRoles });
      setEmail("");
      setDisplayName("");
      setPassword("");
      setSelectedRoles(["Warehouse Operator"]);
      setMessage("User account created.");
      await reload();
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Could not create user.");
    }
  };

  const changeRoles = async (user: UserSummary, nextRoles: string[]) => {
    setError("");
    try {
      await updateUserRoles(user.id, nextRoles);
      setMessage(`Roles updated for ${user.email}. Sign out and sign in again to refresh their access.`);
      await reload();
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : "Could not update user roles.");
    }
  };

  const toggleActive = async (user: UserSummary) => {
    setError("");
    try {
      await setUserActive(user.id, !user.isActive);
      setMessage(`${user.email} ${user.isActive ? "deactivated" : "activated"}.`);
      await reload();
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : "Could not update account.");
    }
  };

  return (
    <section className="enterprise-card user-admin">
      <div className="catalog-heading"><div><p className="eyebrow">IDENTITY & ACCESS</p><h2>User accounts and roles</h2></div><span className="result-count">{users.length} accounts</span></div>
      {error && <div className="notice notice-error" role="alert">{error}</div>}
      {message && <div className="notice notice-success" role="status">{message}</div>}
      <form className="user-create-form" onSubmit={(event) => void submit(event)}>
        <label>Name<input required maxLength={120} value={displayName} onChange={event => setDisplayName(event.target.value)} /></label>
        <label>Email<input type="email" required maxLength={254} value={email} onChange={event => setEmail(event.target.value)} /></label>
        <label>Temporary password<input type="password" required minLength={12} value={password} onChange={event => setPassword(event.target.value)} /></label>
        <label>Starter role<select value={selectedRoles[0] ?? ""} onChange={event => setSelectedRoles(event.target.value ? [event.target.value] : [])}>{roles.map(role => <option key={role} value={role}>{role}</option>)}</select></label>
        <button className="button button-primary" type="submit">Create account</button>
      </form>
      <div className="table-scroll"><table className="activity-table"><thead><tr><th>User</th><th>Roles</th><th>Last sign-in</th><th>Status</th><th>Actions</th></tr></thead><tbody>
        {users.map(user => <tr key={user.id}>
          <td><strong>{user.displayName}</strong><small>{user.email}</small></td>
          <td><select aria-label={`Roles for ${user.email}`} multiple value={user.roles} onChange={event => void changeRoles(user, Array.from(event.target.selectedOptions, option => option.value))}>{roles.map(role => <option key={role} value={role}>{role}</option>)}</select></td>
          <td>{user.lastLoginAtUtc ? new Date(user.lastLoginAtUtc).toLocaleString() : "Never"}</td>
          <td><span className={`status-badge ${user.isActive ? "status-active" : "status-inactive"}`}>{user.isActive ? "Active" : "Inactive"}</span></td>
          <td><button className="icon-button" type="button" onClick={() => void toggleActive(user)}>{user.isActive ? "Deactivate" : "Activate"}</button></td>
        </tr>)}
      </tbody></table></div>
      <p className="field-note">Roles grant fixed permissions: Administrator, Inventory Manager, Warehouse Operator, Purchasing, Sales, and Read-only Auditor. Role changes take effect after the user signs in again.</p>
    </section>
  );
}

function Field({
  children,
  className = "",
  label,
  required = false,
}: {
  children: ReactNode;
  className?: string;
  label: string;
  required?: boolean;
}) {
  return <label className={`field ${className}`}><span className="field-label">{label}{required && <i className="required-dot"> *</i>}</span>{children}</label>;
}

function SortableHeader({
  current,
  direction,
  field,
  label,
  onSort,
}: {
  current: SortField;
  direction: "asc" | "desc";
  field: SortField;
  label: string;
  onSort: (field: SortField) => void;
}) {
  const active = current === field;
  return (
    <th aria-sort={active ? (direction === "asc" ? "ascending" : "descending") : "none"} scope="col">
      <button className={`sort-button ${active ? "sort-active" : ""}`} onClick={() => onSort(field)} type="button">
        {label}<span aria-hidden="true">{active ? (direction === "asc" ? "↑" : "↓") : "↕"}</span>
      </button>
    </th>
  );
}

function ProductThumbnail({ product }: { product: Product }) {
  const firstImage = product.images[0];
  return (
    <div className="product-thumbnail">
      {firstImage ? <img alt="" loading="lazy" src={imageUrl(product.id, firstImage.id)} /> : <span aria-hidden="true">{product.name.slice(0, 1).toUpperCase()}</span>}
      {product.images.length > 1 && <small>+{product.images.length - 1}</small>}
    </div>
  );
}

function ImageDropzone({
  dragging,
  editing,
  files,
  onDragEnter,
  onDragLeave,
  onDrop,
  onFiles,
  onRemoveExisting,
  onRemovePending,
  remaining,
}: {
  dragging: boolean;
  editing: Product | null;
  files: File[];
  onDragEnter: () => void;
  onDragLeave: () => void;
  onDrop: (event: DragEvent<HTMLDivElement>) => void;
  onFiles: (files: FileList | File[]) => void;
  onRemoveExisting: (image: ProductImage) => void;
  onRemovePending: (index: number) => void;
  remaining: number;
}) {
  const allImages = (editing?.images.length ?? 0) + files.length;

  return (
    <section className="image-field" aria-labelledby="image-field-title">
      <div className="image-field-heading"><span className="field-label" id="image-field-title">Product images</span><span className="image-limit">{allImages}/{MAX_IMAGES}</span></div>
      <div className={`dropzone ${dragging ? "dropzone-active" : ""} ${remaining === 0 ? "dropzone-disabled" : ""}`}
        onDragEnter={(event) => { event.preventDefault(); onDragEnter(); }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onDragLeave(); }}
        onDrop={onDrop}>
        <input aria-label="Choose product images" accept={ALLOWED_IMAGE_TYPES.join(",")} disabled={remaining === 0} multiple onChange={(event) => { if (event.target.files) onFiles(event.target.files); event.target.value = ""; }} type="file" />
        <div className="upload-icon" aria-hidden="true">↑</div>
        <strong>Drop images here</strong>
        <span>or <u>browse files</u></span>
        <small>JPEG, PNG or WebP · up to 8 MB each</small>
      </div>
      {allImages > 0 && <div className="image-gallery">
        {editing?.images.map((image) => <div className="gallery-image" key={image.id}><img alt={image.fileName} loading="lazy" src={imageUrl(editing.id, image.id)} /><button aria-label={`Remove ${image.fileName}`} onClick={() => onRemoveExisting(image)} type="button">×</button></div>)}
        {files.map((file, index) => <div className="gallery-image" key={`${file.name}-${file.lastModified}`}><LocalPreview file={file} /><button aria-label={`Remove ${file.name}`} onClick={() => onRemovePending(index)} type="button">×</button><small>NEW</small></div>)}
      </div>}
    </section>
  );
}

export default App;
