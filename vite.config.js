import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  root: "web",
  server: {
    host: "0.0.0.0",
    port: 5173,
    allowedHosts: [".monkeycode-ai.live"],
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3001",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // Split the framework (rarely changing) from application code so
        // returning users keep the vendor chunk cached across deploys.
        manualChunks(id) {
          if (id.includes("node_modules")) {
            if (id.includes("react-router")) return "vendor-router";
            if (id.includes("react")) return "vendor-react";
            return "vendor";
          }
          return undefined;
        },
      },
    },
  },
});
