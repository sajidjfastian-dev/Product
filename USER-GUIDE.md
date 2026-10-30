# Stockroom User Guide

This guide covers the staff inventory workspace and the separate customer storefront. The live system uses the existing SQL Server database; do not treat demo/test instructions as a request to modify production data.

## 1. Open Stockroom

| Screen | URL | Intended user |
|---|---|---|
| Staff workspace | `http://localhost:8081/` | Staff with a Stockroom account |
| Customer storefront | `http://localhost:8081/shop` | Shoppers; no staff account required |
| API health | `http://localhost:8080/health` | Operators |

Use the Docker Compose instructions in [README.md](./README.md) to start the application. The API and web portal must both show `healthy` in `docker compose ps`.

## 2. First-time setup and sign-in

1. Open the staff workspace.
2. If the database has no Stockroom users, the administrator setup form appears.
3. Enter an email, display name, and a password at least 12 characters long containing uppercase, lowercase, a number, and a symbol.
4. Submit once. The first account receives the Administrator role. Setup is then closed to further unauthenticated account creation.
5. On later visits, sign in with that account. The application session expires after 30 minutes; sign in again if required.
6. To leave safely, use the sign-out control in the workspace.

If the page says setup is complete, use an existing account or ask the current administrator to create your account; do not reset the database or remove Docker volumes to try to reopen setup.

## 3. Understand roles and access

An administrator manages accounts from the **Team** tab. Create an account with a temporary password, assign at least one role, and share the credentials securely. Users should change temporary credentials through the organization's approved process; a self-service password-change screen is not currently included.

| Role | Main capabilities |
|---|---|
| Administrator | All Stockroom functions and account administration |
| Inventory Manager | Product maintenance, inventory, sales, purchases, reports, audit |
| Warehouse Operator | Read products and movements; adjust inventory |
| Purchasing | Read products/inventory; receive purchases; view reports |
| Sales | Read products/inventory; complete sales; view reports |
| Read-only Auditor | Read products, inventory, reports, and audit history |

Roles grant fixed permissions. A user can have multiple roles. Changing a user's roles or active state invalidates that user's existing session. The last active Administrator cannot be removed or deactivated.

## 4. Staff workspace overview

The navigation tabs are permission-aware:

- **Overview:** inventory KPIs, low-stock alerts, movement trends, recent movements, and best-selling products.
- **Products:** product catalog, filters, sorting, paging, product forms, image galleries, barcode labels, and PDF export.
- **Sales:** completed sale entry, discounts, and recent sale history.
- **Purchases:** receive supplier deliveries and review recent purchases.
- **Inventory:** review movements and record stock adjustments when permitted.
- **Reports:** export inventory or movement CSV files and view reporting.
- **Team:** create accounts, assign roles, and activate/deactivate accounts (Administrator permission required).

If a tab is missing, ask an administrator to review your role. Hiding a tab is not a substitute for server-side permissions; the API enforces the same permissions.

## 5. Manage products

### Find products

1. Open **Products**.
2. Use search for product name, SKU, barcode, category, brand, or location.
3. Combine filters such as category, brand, location, stock status, and minimum/maximum price.
4. Select a column heading to sort. Use the paging controls to browse results.
5. Use the barcode control on a row to view/print its Code 128 barcode label.

### Add a product

1. Complete the required product name, category, price, and stock fields.
2. Add optional reorder level, SKU, barcode, brand, description, and storage location.
3. Leave barcode blank to have the system assign one automatically. Barcode and SKU values must remain unique.
4. Add up to eight JPEG, PNG, or WebP images. Drag files onto the upload area or browse. Each image must be no larger than 8 MiB.
5. Save. The initial stock is recorded in the inventory movement ledger.

### Edit, archive, and images

- Choose **Edit** on a product row, make changes, and save. Stock changes made in the product form also create a movement record; use the Inventory tab when a reason/reference should be recorded.
- Remove existing gallery images individually, or add additional images without exceeding the eight-image limit.
- **Archive** hides the product from active catalog views without physically deleting its record or historical references. Archived products cannot be edited or used for new sales/purchases.
- Use **Export PDF** to download a printable list of active products.

## 6. Record a sale

Sales are staff-side completed transactions. They immediately decrease on-hand stock; they are not customer checkout or payment processing.

1. Open **Sales**.
2. Optionally enter the customer name.
3. Select a product and quantity. Add a line discount from 0% to 100% if approved.
4. Add more product lines. A product can appear once per order; change its quantity on that line rather than adding a duplicate.
5. Optionally enter an order discount from 0% to 100%. The order discount is calculated after line discounts.
6. Review the total and select **Complete sale**.
7. Check the generated sale reference and verify the updated stock/history.

The server uses the saved catalog price, recalculates discounts, checks stock, writes the sale and movement/audit records, and updates quantities in one database transaction. If stock is insufficient, correct the quantity or receive/adjust stock before retrying. Do not retry blindly after a network error; first check the sale history for the generated reference.

## 7. Receive a purchase

1. Open **Purchases**.
2. Enter the supplier name.
3. Select a product, quantity, and per-unit cost; add further lines as needed.
4. Review the calculated total and select **Receive purchase**.
5. Confirm the purchase reference and updated stock.

Receiving is immediate: stock increases and the purchase, movement, and audit records are saved together. There is no draft, approval, or partial-receipt workflow.

## 8. Manage inventory

The **Inventory** tab provides the movement ledger and adjustment form. Adjustments require the `inventory.adjust` permission.

1. Select the affected product.
2. Enter a positive or negative whole-number quantity change. A change of zero is not allowed.
3. Enter a reason (required) and optional reference, such as a count sheet or damage case.
4. Submit and review the resulting balance and new ledger entry.

The balance cannot go below zero. Investigate discrepancies and use a descriptive reason rather than changing stock without a traceable explanation. Sales and received purchases also generate ledger movements automatically.

## 9. Reports and audit trail

- Use **Overview** for current stock value, units, low/out-of-stock items, recent movements, and best sellers.
- **Inventory CSV** exports active products; **Movement CSV** exports the movement ledger. Spreadsheet software may prompt about CSV encoding; the files include a UTF-8 BOM.
- The product PDF is a print-friendly active-product list.
- The audit history records important catalog, image, inventory, account, sale, and purchase actions. Access requires `audit.read`.
- Best sellers are ranked by completed units sold. The revenue metric allocates order-level discounts across sale lines.

## 10. Customer storefront

The customer storefront is separate from the staff tabs and does not require staff authentication.

1. Open `/shop`.
2. Search the in-stock catalog or choose a category. The store loads 24 products at a time; choose **Load more products** to fetch the next page. Select a product card for details.
3. Add a product to the cart. Change quantities or remove items on the Cart page.
4. Use browser Back/Forward or the Shop navigation to move between catalog pages.
5. The cart currently lives only in the open browser page. Reloading or closing the page clears it.

### Shopping assistant

The chat assistant can recommend catalog products and navigate to product details, categories, cart, checkout preview, or order-status preview. It shows its shopper-facing message; internal routing JSON is not displayed. Routing is restricted to the known application routes.

AI chat requires an administrator/operator to configure an OpenAI API key in the local, ignored `.env` file and recreate the API service with `docker compose up -d`. Without the key, the catalog remains usable and chat reports that the assistant is not configured. When enabled, Qdrant searches embeddings of product catalog descriptions; the API checks live product availability and sends relevant product matches and shopper messages to the configured OpenAI services. Qdrant is internal to Docker and its index is persisted separately from SQL Server. Do not send passwords, payment information, or other sensitive personal data to the assistant.

**Checkout and order status are previews only.** No payment is accepted, no customer order is created, and no tracking information is available. The only implemented sales flow is the staff-only completed-sale workflow described above.

## 11. Troubleshooting

| Symptom | What to check |
|---|---|
| Cannot open the portal | Run `docker compose ps`; wait until both services are healthy. Check `docker compose logs --tail 100 api` and `docker compose logs --tail 100 web`. |
| API is unhealthy | Verify SQL Server is reachable from Docker, `.env` has the correct SQL Server port/user/password, and SQL Server accepts the configured login. Never post credentials in an issue or chat. |
| Sign-in rejected | Check email/password and account active state with an administrator. Five bad attempts may lock the account for 15 minutes. |
| User lacks a tab or receives access denied | Ask an Administrator to assign the required role. Sign in again after role changes. |
| Product upload fails | Use JPEG, PNG, or WebP; each file must be at most 8 MiB and each product can have up to eight images. |
| Customer chat says it is not configured | Set `OPENAI_API_KEY` in the local ignored `.env`, optionally set `OPENAI_MODEL`, then run `docker compose up -d --build`. Never put the key in frontend code or commit it. |
| Customer chat cannot search products | Check that the Qdrant service is running with `docker compose ps`; restart the stack with `docker compose up -d` if needed. |
| Chat provider reports unavailable | Check that the key is valid, the chosen model supports strict JSON Schema structured outputs, outbound HTTPS is available, and provider limits/billing are configured. |
| A sale/purchase request is uncertain | Check the Sales/Purchases history and generated reference before retrying. The server transaction prevents partial stock updates. |

## 12. Safe operation and data retention

- SQL Server data is external to Docker Compose. Compose does not create, back up, or delete the SQL Server database.
- `docker compose down` stops services but preserves the session-signing-key volume and database.
- Avoid `docker compose down -v`: it removes the session key and vector index. The vector index can be rebuilt from SQL Server products when embeddings are configured; removing the session key signs everyone out. It does not erase the external SQL Server database.
- Back up the SQL Server database using the organization's standard SQL Server backup and restore process before upgrades or operational changes.
- Keep `.env` private and untracked. Use HTTPS with `COOKIE_SECURE=true` before exposing the portal beyond a trusted local network.
- Do not expose the database directly to the public internet. Restrict SQL Server access to the application host and authorized administrators.

## 13. Application scope

Current scope includes a single inventory location, staff accounts/roles, product catalog/images/barcodes, inventory movements, immediate sales and received purchases, reports, audit history, and a public product-discovery storefront.

Not implemented: customer registration, persistent customer carts, online payment processing, tax/shipping calculation, draft/approved orders, customer-created sales, customer order lookup, returns/refunds, multi-warehouse inventory, supplier accounts, scheduled promotions, and self-service password changes.
