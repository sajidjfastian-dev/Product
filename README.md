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

The public customer storefront is available at `http://localhost:8081/shop`; the existing staff workspace remains at `/`. The storefront shows in-stock products and their first catalog image, and its assistant uses OpenAI Chat Completions with strict JSON Schema output before the frontend handles an allowlisted client-side route. Product discovery combines semantic vector retrieval from Qdrant with keyword search, then checks current availability, prices, and product details against SQL Server before giving results to the model. The first searchable chat builds the product vector index and may take longer; subsequent searches reconcile changes at most once per minute. Product content and shopper queries are sent to OpenAI for embeddings, and relevant product matches and conversation messages are sent to the configured chat model. Qdrant runs as an internal Docker service and persists its index in the `vector-data` volume. Product descriptions are treated as untrusted data, not instructions. The customer catalog does not require staff authentication. Customer checkout, payment processing, customer accounts, and order lookup are not connected yet; those screens are explicitly marked as previews and do not create sales.

To enable AI chat, add your own provider key to the local ignored `.env` file (never commit or share it), for example `OPENAI_API_KEY=...`; optionally set `OPENAI_MODEL`. Then apply the environment update with `docker compose up -d`. The selected model must support Chat Completions structured outputs / strict JSON Schema. The implemented stack is Node.js 24, Express 5, SQL Server, React 19, TypeScript, Vite, and the OpenAI-compatible Chat Completions API.

## User and API documentation

- [Full user guide](./USER-GUIDE.md) covers setup, roles, inventory workflows, storefront, troubleshooting, and safe operations.
- [API specification (PDF)](./API-SPECIFICATION.pdf) is generated from the maintained [API specification source](./API-SPECIFICATION.md).
- Regenerate the API PDF after editing its Markdown source with Node.js 24: `Set-Location .\NodeApi; npm ci; npm run docs:pdf`.

The API adds the sales and purchase tables to SQL Server if they do not already exist. It retains existing products, images, user accounts, roles, permissions, movements, and audit records. Named Docker volumes store the API session-signing key and Qdrant's product vector index. `docker compose down` preserves these volumes and the SQL database. Avoid `docker compose down -v` unless you intend to remove the session key and vector index; the index will be rebuilt from SQL Server products when needed, but this requires OpenAI embeddings. Removing the session key signs users out. Neither action deletes the external SQL Server database.

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

For endpoint methods, request/response contracts, permissions, and status codes, see the complete [API specification](./API-SPECIFICATION.md) or its [PDF version](./API-SPECIFICATION.pdf). Staff APIs require the corresponding signed-in role permission; public storefront and authentication endpoints are documented separately. State-changing requests require a CSRF token.

## Local frontend development

The production portal is a Node.js/Express static host plus same-origin API proxy. The Vite development server proxies API requests to `http://localhost:8080`; Node.js 24 is required:

```powershell
Set-Location .\SampleWeb\ClientApp
npm ci
npm run dev
```

## Debug in Visual Studio Code

Open the repository root in VS Code and install dependencies once with `npm ci` in both `NodeApi` and `SampleWeb\ClientApp`. Ensure the local `.env` file has the SQL Server credentials described above and that SQL Server is reachable at `127.0.0.1` using `SQLSERVER_PORT`.

In **Run and Debug**, select **Debug full stack** and press F5 to launch the API and the portal in Chrome. Use **Debug Node API** or **Debug Portal in Chrome** to debug either service by itself. Breakpoints in the API TypeScript source and portal source are enabled. The API uses port 8080, the Vite portal uses port 5173, and the API's development session key is stored under the Windows temp directory.

Build and test the API from its project folder with Node.js 24:

```powershell
Set-Location .\NodeApi
npm ci
npm test
npm run build
```

The product catalog sample JSON files are retained under [`SampleApi/test-data`](./SampleApi/test-data). Production startup no longer reseeds or rewrites product data.
