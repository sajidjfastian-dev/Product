# Product Catalog

A Dockerized .NET 10 API and browser portal backed by the local SQL Server Express instance `SAJID-ALI\SQLEXPRESS`.

## Deployment

The local SQL Express instance is configured to accept SQL-authenticated TCP connections on port `1433`. The `ProductCatalogDb` database and a dedicated `productapi_docker` login have been created. The app login is limited to reading, writing, and creating its database objects.

The connection credentials are in the ignored local `.env` file. Do not commit that file. To deploy or rebuild the API and portal:

```powershell
docker compose up --build -d --remove-orphans
```

Open the portal at `http://localhost:8080`. Check `http://localhost:8080/health` for service health. The API container connects to the host database through `host.docker.internal`; the database itself stays on the Windows SQL Express instance and is not stored in a Docker volume.

Stop the web/API container with `docker compose down`. The local SQL database and its data are not removed.

## Portal

The portal at `/` lists and searches products, provides create/edit/delete actions, and downloads the full catalog as a PDF. The PDF is generated from the current SQL Server data when requested.

## API endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/products` | Create a product |
| `PUT` | `/api/products/{id}` | Update a product |
| `DELETE` | `/api/products/{id}` | Delete a product |
| `GET` | `/api/products` | List products (optional `?category=Accessories`) |
| `GET` | `/api/products/pdf` | Download all products as `products.pdf` |

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

The SQL Express connection requires TCP/IP and SQL Authentication on the host instance. The API login credentials are managed in `.env`, which is excluded from Docker build context and source control. The `.env.example` file shows the required variable names; if setting up another machine, create the database and login there and set matching values in `.env`.
