import { defineConfig, lazyPlugins } from "vite-plus";
import react from "@vitejs/plugin-react";

// Tauri expects a fixed port and must not clear the screen on errors.
export default defineConfig({
  fmt: {},
  lint: {
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
  plugins: lazyPlugins(() => [react()]),
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    target: "chrome105",
    // Vite 8 minifies with Oxc; the old esbuild minifier now requires a
    // separately installed esbuild package.
    minify: "oxc",
    sourcemap: false,
  },
});
