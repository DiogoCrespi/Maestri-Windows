import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules")) {
            if (id.includes("@xyflow") || id.includes("reactflow")) {
              return "vendor-reactflow";
            }
            if (id.includes("@xterm") || id.includes("xterm")) {
              return "vendor-xterm";
            }
            if (id.includes("@tauri-apps")) {
              return "vendor-tauri";
            }
            if (id.includes("react") || id.includes("react-dom") || id.includes("zustand")) {
              return "vendor-react";
            }
          }
        },
      },
    },
  },
});
