import sql from "mssql";

const port = Number(process.env.SQLSERVER_PORT ?? "1433");
const config: sql.config = {
  server: process.env.SQLSERVER_HOST ?? "host.docker.internal",
  port,
  database: process.env.SQLSERVER_DATABASE ?? "ProductCatalogDb",
  user: process.env.SQLSERVER_USER,
  password: process.env.SQLSERVER_PASSWORD,
  options: {
    encrypt: true,
    trustServerCertificate: true,
    enableArithAbort: true,
  },
  pool: { max: 10, min: 0, idleTimeoutMillis: 30_000 },
};

let connection: Promise<sql.ConnectionPool> | undefined;

export function getPool(): Promise<sql.ConnectionPool> {
  if (!process.env.SQLSERVER_USER || !process.env.SQLSERVER_PASSWORD) {
    throw new Error("SQLSERVER_USER and SQLSERVER_PASSWORD are required.");
  }

  const pending = connection ?? new sql.ConnectionPool(config).connect();
  connection = pending.catch((error: unknown) => {
    connection = undefined;
    throw error;
  });
  return connection;
}

export { sql };
