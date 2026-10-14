import path from "path";
import { fileURLToPath } from "url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// https://vite.dev/config/
// Stage 1: clearScreen / server port 1420 / strictPort are Tauri's documented
// requirements so `tauri dev` can drive the vite dev server without port drift
// or terminal handover fighting the Rust process for the TTY.
export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: "127.0.0.1",
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
