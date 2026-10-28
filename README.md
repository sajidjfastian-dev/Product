# Product Catalog

The Visual Studio solution [`ProductCatalog.sln`](./ProductCatalog.sln) contains two independent .NET 10 projects:

- **SampleApi** — product CRUD API, SQL Server persistence, seed data, and PDF export.
- **SampleWeb** — browser portal for listing, searching, adding, editing, and deleting products.

Open `ProductCatalog.sln` in a Visual Studio release that supports the .NET 10 SDK. This repository targets .NET 10; the older Visual Studio 2022 17.1 release does not support building it.

## Run with Docker Compose

The API connects to the local SQL Server Express instance `SAJID-ALI\SQLEXPRESS`. The host needs TCP/IP enabled on port 1433, the `ProductCatalogDb` database, and a SQL login with the permissions described in the database notes below.

Set `SQLSERVER_PORT`, `SQLSERVER_USER`, and `SQLSERVER_PASSWORD` in the local, ignored `.env` file. Then run:

```powershell
docker compose up --build -d
```

Open the portal at `http://localhost:8081`. The API is at `http://localhost:8080`; health checks are available at `/health` on both services. The web container is separate from the API container and sends browser requests to the configured public API URL.

Stop the containers with `docker compose down`. The SQL database remains on the host and is not deleted.

## Run from Visual Studio

Set `SampleApi` as the startup project to run the API and `SampleWeb` as the startup project to run the portal. The API connection string can be supplied using the `ConnectionStrings__Products` environment variable; its frontend CORS origin defaults to `http://localhost:8081`. The Web project reads `ProductsApiUrl`, which defaults to `http://localhost:8080`.

For local development with both projects running, use the HTTP URLs above or adjust the web API URL and the API's `Frontend:Origin` setting to match the launch URLs.

## API endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/products` | Create a product |
| `PUT` | `/api/products/{id}` | Update a product |
| `DELETE` | `/api/products/{id}` | Delete a product |
| `GET` | `/api/products` | List products (optional `?category=Accessories`) |
| `GET` | `/api/products/pdf` | Download the full list as `products.pdf` |

Create and update requests use this JSON shape:

```json
{
  "name": "Webcam",
  "category": "Accessories",
  "price": 59.99,
  "stock": 18
}
```

Names and categories are required; prices and stock counts cannot be negative.

## Database notes

The initial test products are in [SampleApi/test-data/products.json](./SampleApi/test-data/products.json) and are inserted into `ProductCatalogDb` once. The seed marker prevents deleted products from being reinserted on later API restarts.

The API login should be limited to database reader/writer and DDL permissions on `ProductCatalogDb`. Keep its password in `.env`, which is excluded from Git and Docker build context. `.env.example` documents the required variable names.
