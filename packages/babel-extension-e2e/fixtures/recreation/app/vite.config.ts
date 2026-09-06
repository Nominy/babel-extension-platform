import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ command }) => {
  const apiURL = process.env.BABEL_E2E_API_URL;
  if (command === "serve" && !apiURL) {
    throw new Error("BABEL_E2E_API_URL is required. Start the local @nominy/babel-extension-e2e scenario server before running the recreation; live Babel APIs are never used.");
  }
  if (apiURL) {
    const target = new URL(apiURL);
    if (target.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) || target.username || target.password) {
      throw new Error("BABEL_E2E_API_URL must be an HTTP loopback URL without credentials.");
    }
  }
  return {
    plugins: [react()],
    server: {
      host: "127.0.0.1",
      port: 53203,
      strictPort: true,
      proxy: apiURL ? {
        "/api": { target: apiURL, changeOrigin: true },
        "/__e2e__": { target: apiURL, changeOrigin: true },
        "/v1": { target: apiURL, changeOrigin: true },
      } : undefined,
    },
  };
});
