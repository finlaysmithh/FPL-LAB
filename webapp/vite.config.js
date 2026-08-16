import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // Served from /app on the same site as the landing page.
  base: "/app/",
  plugins: [react()],
  server: { port: 5173 },
});
