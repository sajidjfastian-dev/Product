const form = document.querySelector("#product-form");
const rows = document.querySelector("#product-rows");
const count = document.querySelector("#product-count");
const message = document.querySelector("#message");
const search = document.querySelector("#search");
const title = document.querySelector("#form-title");
const saveButton = document.querySelector("#save-button");
const cancelButton = document.querySelector("#cancel-edit");
const emptyState = document.querySelector("#empty-state");
const apiBaseUrl = window.productCatalogConfig.apiBaseUrl.replace(/\/+$/, "");
let products = [];
let editingId = null;

async function request(path, options) {
  const response = await fetch(`${apiBaseUrl}${path}`, options);
  if (!response.ok) {
    let detail = `Request failed (${response.status}).`;
    try {
      const body = await response.json();
      detail = body.errors
        ? Object.values(body.errors).flat().join(" ")
        : body.title || detail;
    } catch {
      // Keep the HTTP status message when the response has no JSON body.
    }
    throw new Error(detail);
  }
  return response.status === 204 ? null : response.json();
}

function showMessage(text, isError = false) {
  message.textContent = text;
  message.classList.toggle("error", isError);
}

function renderProducts() {
  const query = search.value.trim().toLocaleLowerCase();
  const visible = products.filter(product =>
    `${product.name} ${product.category}`.toLocaleLowerCase().includes(query));

  count.textContent = products.length;
  rows.replaceChildren();
  emptyState.classList.toggle("hidden", visible.length !== 0);

  for (const product of visible) {
    const row = document.createElement("tr");
    const nameCell = document.createElement("td");
    const categoryCell = document.createElement("td");
    const priceCell = document.createElement("td");
    const stockCell = document.createElement("td");
    const actionsCell = document.createElement("td");
    const actions = document.createElement("div");
    const edit = document.createElement("button");
    const remove = document.createElement("button");

    nameCell.textContent = product.name;
    categoryCell.textContent = product.category;
    priceCell.className = "price";
    priceCell.textContent = Number(product.price).toFixed(2);
    stockCell.className = "stock";
    stockCell.textContent = product.stock;
    actions.className = "actions";
    edit.className = "action-button";
    edit.type = "button";
    edit.textContent = "Edit";
    edit.addEventListener("click", () => beginEdit(product));
    remove.className = "action-button delete";
    remove.type = "button";
    remove.textContent = "Delete";
    remove.addEventListener("click", () => deleteProduct(product));
    actions.append(edit, remove);
    actionsCell.append(actions);
    row.append(nameCell, categoryCell, priceCell, stockCell, actionsCell);
    rows.append(row);
  }
}

async function loadProducts() {
  products = await request("/api/products");
  renderProducts();
}

document.querySelector("#download-pdf").href = `${apiBaseUrl}/api/products/pdf`;

function resetForm() {
  editingId = null;
  form.reset();
  title.textContent = "Add a product";
  saveButton.textContent = "Add product";
  cancelButton.classList.add("hidden");
}

function beginEdit(product) {
  editingId = product.id;
  form.elements.name.value = product.name;
  form.elements.category.value = product.category;
  form.elements.price.value = product.price;
  form.elements.stock.value = product.stock;
  title.textContent = "Edit product";
  saveButton.textContent = "Save changes";
  cancelButton.classList.remove("hidden");
  showMessage("");
  form.elements.name.focus();
}

async function deleteProduct(product) {
  if (!window.confirm(`Delete "${product.name}"?`)) return;
  try {
    await request(`/api/products/${product.id}`, { method: "DELETE" });
    if (editingId === product.id) resetForm();
    await loadProducts();
    showMessage(`${product.name} deleted.`);
  } catch (error) {
    showMessage(error.message, true);
  }
}

form.addEventListener("submit", async event => {
  event.preventDefault();
  const body = {
    name: form.elements.name.value.trim(),
    category: form.elements.category.value.trim(),
    price: Number(form.elements.price.value),
    stock: Number(form.elements.stock.value)
  };
  const wasEditing = editingId !== null;
  const path = wasEditing ? `/api/products/${editingId}` : "/api/products";

  try {
    await request(path, {
      method: wasEditing ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    resetForm();
    await loadProducts();
    showMessage(wasEditing ? "Product updated." : "Product added.");
  } catch (error) {
    showMessage(error.message, true);
  }
});

cancelButton.addEventListener("click", () => {
  resetForm();
  showMessage("");
});

search.addEventListener("input", renderProducts);

loadProducts().catch(error => showMessage(error.message, true));
