# Stockroom inventory

Stockroom deploys its API and portal as Node.js 24 / Express services. The portal uses React, TypeScript, and Vite; the API uses TypeScript, Express, and the SQL Server driver. Both services connect to the existing SQL Server database `ProductCatalogDb`; the Docker Compose migration does not replace the database or reseed its product rows and image galleries.

The original Visual Studio solution and .NET projects remain in the repository as legacy source. Docker Compose now builds and runs the Node.js services.

## Run with Docker Compose

Set `SQLSERVER_PORT`, `SQLSERVER_USER`, and `SQLSERVER_PASSWORD` in the local, ignored `.env` file. Set `OPENAI_API_KEY` there to enable the shopping assistant; `OPENAI_MODEL` defaults to `gpt-4o-mini`. The API key remains server-side and is never sent to the browser. Without a key, the public catalog still works and chat responds with a clear configuration message. `COOKIE_SECURE=false` is suitable for the local HTTP URLs below. Start the services from the repository root:

```powershell
docker compose up --build -d
docker compose ps
```

Open the portal at `http://localhost:8081`. The portal proxies `/api` requests to the Node API, so browser authentication cookies, product images, and API calls use the same origin. The API is also available directly at `http://localhost:8080`; health checks are available at `/health`.

The public customer storefront is available at `http://localhost:8081/shop`; the existing staff workspace remains at `/`. The storefront shows in-stock products and their first catalog image, and its assistant uses OpenAI Chat Completions with strict JSON Schema output before the frontend handles an allowlisted client-side route. The customer catalog does not require staff authentication. Customer checkout, payment processing, customer accounts, and order lookup are not connected yet; those screens are explicitly marked as previews and do not create sales.

To enable AI chat, add your own provider key to the local ignored `.env` file (never commit or share it), for example `OPENAI_API_KEY=...`; optionally set `OPENAI_MODEL`. Then rebuild/restart with `docker compose up -d --build`. The selected model must support Chat Completions structured outputs / strict JSON Schema. The implemented stack is Node.js 24, Express 5, SQL Server, React 19, TypeScript, Vite, and the OpenAI-compatible Chat Completions API.

The API adds the sales and purchase tables to SQL Server if they do not already exist. It retains existing products, images, user accounts, roles, permissions, movements, and audit records. A named Docker volume stores the API session-signing key. `docker compose down` preserves this key and the SQL database. Avoid `docker compose down -v` unless you intend to remove the local session-key volume; it will sign users out, but it does not delete the SQL Server database.

For HTTPS deployments, set `COOKIE_SECURE=true` and configure the public portal/API behind HTTPS. Do not expose an HTTP deployment to untrusted networks.

## Workspace tabs and permissions

The portal provides permission-aware **Overview**, **Products**, **Sales**, **Purchases**, **Inventory**, **Reports**, and **Team** tabs. The existing catalog supports search, filters, sorting, paging, product details, drag-and-drop JPEG/PNG/WebP images, and Code 128 barcode labels.

The first-run administrator screen remains available when the database has no portal accounts. It requires a valid email, display name, and a password of at least 12 characters with uppercase and lowercase letters, a number, and a symbol. Existing ASP.NET Core Identity password hashes are verified by the Node API, so existing accounts can keep signing in after the service migration. The API refreshes permissions from SQL Server and invalidates sessions when account roles or active state change.

## Sales and purchases

- **Sales** are completed immediately, snapshot product names, SKUs, and selling prices, and decrease on-hand stock in the same SQL transaction as the sale record and movement ledger.
- **Discounts** support a percentage on each sale line and a further percentage on the order subtotal after line discounts. Values outside 0–100% are rejected. The server calculates totals from the current catalog price; the browser cannot set a sale unit price.
- **Purchases** are recorded as received immediately. Enter the supplier, quantity, and per-unit cost; the transaction stores a purchase record and increases product stock together with the corresponding movement ledger entries.
- **Best-selling items** are ranked by completed units sold. Reported net item revenue accounts proportionally for order-level discounts.
- Sales reject duplicate product lines and insufficient stock. Both order types run inside serializable SQL transactions; invalid orders leave stock unchanged.

These are completed-transaction workflows, not draft orders, payment processing, returns, refunds, or purchase approval flows.

## API endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/auth/status`, `/api/auth/csrf` | First-run setup status and CSRF token |
| `POST` | `/api/auth/bootstrap`, `/api/auth/login`, `/api/auth/logout` | Account setup and session sign-in/out |
| `GET` | `/api/auth/me` | Current signed-in account |
| `GET`, `POST`, `PUT` | `/api/auth/admin/users...` | User, role, and account-state administration |
| `GET`, `POST`, `PUT`, `DELETE` | `/api/products...` | Filtered product catalog, create, update, archive, and images |
| `GET` | `/api/products/pdf` | Product inventory PDF |
| `GET`, `POST` | `/api/inventory...` | Movement history and stock adjustments |
| `GET` | `/api/reports/dashboard` | Stock KPIs, movements, alerts, and best sellers |
| `GET` | `/api/reports/inventory.csv`, `/api/reports/movements.csv` | Inventory and stock-ledger exports |
| `GET` | `/api/audit` | Auditable change history |
| `GET`, `POST` | `/api/sales` | Sale history and completed discounted sales |
| `GET`, `POST` | `/api/purchases` | Purchase history and received purchases |
| `GET` | `/api/store/products`, `/api/store/products/:identifier` | Public in-stock customer catalog |
| `GET` | `/api/store/products/:productId/images/:imageId` | Public catalog product image |
| `POST` | `/api/customer-assistant/chat` | Catalog-aware AI chat and validated route intent |

API endpoints require the corresponding signed-in role permission, except health and first-run/sign-in endpoints. State-changing requests also require a CSRF token.

## Local frontend development

The production portal is a Node.js/Express static host plus same-origin API proxy. The Vite development server proxies API requests to `http://localhost:8080`; Node.js 24 is required:

```powershell
Set-Location .\SampleWeb\ClientApp
npm ci
npm run dev
```

Build and test the API from its project folder with Node.js 24:

```powershell
Set-Location .\NodeApi
npm ci
npm test
npm run build
```

The product catalog sample JSON files are retained under [`SampleApi/test-data`](./SampleApi/test-data). Production startup no longer reseeds or rewrites product data.
