import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev server proxies API + static run products to the FastAPI backend (default 8365).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5373,
    proxy: {
      "/api": "http://127.0.0.1:8365",
      "/runs": "http://127.0.0.1:8365",
    },
  },
  build: {
    outDir: "dist",
  },
});
