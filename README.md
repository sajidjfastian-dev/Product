# Product Catalog

The Visual Studio solution [`ProductCatalog.sln`](./ProductCatalog.sln) contains two independently deployable .NET 10 services:

- **SampleApi** — SQL Server product API, database initialization, image upload/storage, and PDF export.
- **SampleWeb** — ASP.NET Core static web host serving a React 19.3 + TypeScript 7 + Vite 8 application.

The React/Vite build uses Node.js 24 LTS. The Dockerfile builds the frontend and .NET services as separate image targets; Compose runs separate API and Web containers.

## Run with Docker Compose

Set `SQLSERVER_PORT`, `SQLSERVER_USER`, and `SQLSERVER_PASSWORD` in the local, ignored `.env` file. The API connects to the configured SQL Server Express instance. Start the services with:

```powershell
docker compose up --build -d
```

Open the portal at `http://localhost:8081`. The API is at `http://localhost:8080`; health checks are available at `/health` on both services. The SQL database and product image binaries remain together in SQL Server.

Stop the web and API containers with `docker compose down`. Product records and image data remain in SQL Server.

## Product catalog

The product form supports barcode, unique SKU, description, brand, storage location, price, stock quantity, and up to 8 JPEG/PNG/WebP images (8 MB per image). Product photos can be selected or dragged into the upload area and are persisted in SQL Server.

The catalog grid supports server-side search across product identifiers and details, category/brand/location/stock/price filters, sortable columns, and pagination.

On first startup with this version, the API adds a generated sample illustration to every existing product that does not already have an image. It also adds 100 additional sample products covering accessories, adapters, displays, storage, networking, audio, cameras, office equipment, cables, and components. The illustrations are generated product-category artwork (not product photographs) and are stored in SQL Server with the product galleries. Seeding is tracked in SQL Server and will not add duplicates on subsequent restarts; existing products are preserved.

## API endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/products` | Search and page through products; supports `search`, `category`, `brand`, `location`, `stock`, `minPrice`, `maxPrice`, `page`, `pageSize`, `sortBy`, and `sortDirection` |
| `POST` | `/api/products` | Create a product |
| `PUT` | `/api/products/{id}` | Update a product |
| `DELETE` | `/api/products/{id}` | Delete a product and its image gallery |
| `POST` | `/api/products/{id}/images` | Upload one or more gallery images using multipart field `files` |
| `GET` | `/api/products/{id}/images/{imageId}` | Retrieve a stored product image |
| `DELETE` | `/api/products/{id}/images/{imageId}` | Remove one image from a product gallery |
| `GET` | `/api/products/pdf` | Download the full product list as `products.pdf` |

Create and update requests use this JSON shape:

```json
{
  "name": "Webcam",
  "category": "Accessories",
  "price": 59.99,
  "stock": 18,
  "barcode": "8901000000066",
  "sku": "ACC-CAM-006",
  "description": "HD webcam with autofocus.",
  "location": "Aisle A / Shelf 4",
  "brand": "Northstar"
}
```

## Local frontend development

Start the API with Visual Studio or `dotnet run --project .\SampleApi\SampleApi.csproj`. With Node.js 24 installed, start the Vite development server:

```powershell
Set-Location .\SampleWeb\ClientApp
npm ci
npm run dev
```

The Vite development server proxies API requests to `http://localhost:8080`. For the published Web service, `ProductsApiUrl` sets the API address rendered into the runtime configuration script.

To serve the built frontend through the `SampleWeb` ASP.NET Core project in Visual Studio, run `npm ci` and `npm run build` from `SampleWeb\ClientApp` first, then start `SampleWeb`.

## Database notes

The initial test products are in [SampleApi/test-data/products.json](./SampleApi/test-data/products.json), with the additional 100 sample products in [SampleApi/test-data/additional-sample-products.json](./SampleApi/test-data/additional-sample-products.json). Existing databases are extended on API startup with the optional product columns and image table without dropping existing product records. Barcode and SKU are unique when provided.

Keep the SQL login password in `.env`, which is excluded from Git and Docker build context. `.env.example` documents the required variable names.
