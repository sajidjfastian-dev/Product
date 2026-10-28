import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    react(),
    {
      name: "runtime-config",
      configureServer(server) {
        server.middlewares.use("/config.js", (_request, response) => {
          response.setHeader("Content-Type", "application/javascript");
          response.end("window.productCatalogConfig = { apiBaseUrl: '' };");
        });
      },
    },
  ],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": "http://localhost:8080",
      "/health": "http://localhost:8080",
    },
  },
});
