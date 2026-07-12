import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The Ravel service (run `ravel serve`) listens on 4317 by default.
const API = process.env.RAVEL_API ?? "http://localhost:4317";

export default defineConfig({
  // Relative asset URLs so the console works both at / and mounted under a
  // path prefix (e.g. a platform gateway's /teams/<id>/).
  base: "./",
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: API, changeOrigin: true },
    },
  },
});
