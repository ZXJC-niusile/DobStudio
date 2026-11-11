import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: ".",
  plugins: [react()],
  // Relative asset URLs. Electron loads the built page over `file://`, where an
  // absolute `/assets/...` resolves to the filesystem root and the bundle is
  // never found — the page loads, the preload runs, and React silently never
  // mounts.
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: "index.html",
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
