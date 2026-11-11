import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `npm run dev:dashboard` proxies API/MCP calls to `wrangler dev` on :8787.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { "/api": "http://localhost:8787", "/oauth": "http://localhost:8787", "/mcp": "http://localhost:8787" } },
  build: { outDir: "dist", sourcemap: false },
});
