import {
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useState,
} from "react";
import { deleteProduct, imageUrl, listProducts, pdfUrl, removeImage, saveProduct, uploadImages } from "./api";
import type { Product, ProductDraft, ProductImage } from "./types";

const PAGE_SIZE_OPTIONS = [10, 20, 50];
const MAX_IMAGES = 8;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];

const blankDraft: ProductDraft = {
  name: "",
  category: "",
  price: "",
  stock: "",
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
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Could not delete product.");
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
          <td className="mono">{product.barcode || <span className="muted">—</span>}</td>
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
            <button className="icon-button" type="button" aria-label={`Edit ${product.name}`} onClick={() => startEdit(product)}>Edit</button>
            <button className="icon-button danger-action" type="button" aria-label={`Delete ${product.name}`} onClick={() => void removeProduct(product)}>Delete</button>
          </td>
        </tr>
  ));

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand-lockup" href="/" aria-label="Stockroom home">
          <span className="brand-mark">S</span>
          <span className="brand-copy"><strong>stockroom</strong><small>PRODUCT OPERATIONS</small></span>
        </a>
        <div className="topbar-actions">
          <span className="connection-status"><i /> SQL SERVER CONNECTED</span>
          <a className="button button-outline" href={pdfUrl()} target="_blank" rel="noreferrer">Export PDF <span aria-hidden="true">↗</span></a>
          <button className="button button-primary" type="button" onClick={startCreate}><span aria-hidden="true">＋</span> Add product</button>
        </div>
      </header>

      <section className="page-intro">
        <div>
          <p className="eyebrow">INVENTORY OVERVIEW</p>
          <h1>Products <span className="product-total">{productPage.totalCount}</span></h1>
          <p className="intro-copy">A clear view of your catalog, stock levels, and product details.</p>
        </div>
        <div className="intro-decoration" aria-hidden="true"><span>01</span><i /><span>CATALOG</span></div>
      </section>

      {message && <div className="notice notice-success" role="status">{message}<button type="button" onClick={() => setMessage("")} aria-label="Dismiss message">×</button></div>}
      {error && <div className="notice notice-error" role="alert">{error}<button type="button" onClick={() => setError("")} aria-label="Dismiss error">×</button></div>}

      <section className="editor-card" id="product-editor">
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
              <Field label="Barcode"><input autoComplete="off" maxLength={64} name="barcode" onChange={updateDraft} placeholder="Scan or enter barcode" value={draft.barcode} /></Field>
              <Field label="SKU"><input autoComplete="off" maxLength={64} name="sku" onChange={updateDraft} placeholder="e.g. ACC-MOUSE-001" value={draft.sku} /></Field>
              <Field label="Brand"><input maxLength={120} name="brand" onChange={updateDraft} placeholder="Brand name" value={draft.brand} /></Field>
              <Field label="Storage location"><input maxLength={120} name="location" onChange={updateDraft} placeholder="e.g. Aisle A / Shelf 1" value={draft.location} /></Field>
              <Field label="Unit price" required><div className="input-prefix"><span>$</span><input min="0" name="price" onChange={updateDraft} placeholder="0.00" required step="0.01" type="number" value={draft.price} /></div></Field>
              <Field label="Quantity in stock" required><input min="0" name="stock" onChange={updateDraft} placeholder="0" required step="1" type="number" value={draft.stock} /></Field>
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
            <p className="form-hint"><span className="required-dot">*</span> Required fields <span className="form-divider">·</span> Barcode and SKU must be unique</p>
            <button className="button button-primary save-button" disabled={busy} type="submit">{busy ? "Saving…" : editing ? "Save changes" : "Create product"} <span aria-hidden="true">→</span></button>
          </div>
        </form>
      </section>

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

      <footer className="app-footer"><span>STOCKROOM <i>·</i> PRODUCT OPERATIONS</span><span>IMAGES STORED SECURELY IN SQL SERVER</span></footer>
    </main>
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
