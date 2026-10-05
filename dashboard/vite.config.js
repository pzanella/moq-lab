import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// `pnpm dev` serves the UI with hot reload and forwards /api to a dashboard
// server that's already running (./stream.sh <name> --dashboard), so you can
// iterate on the UI against a live stream without rebuilding the image.
export default defineConfig({
    plugins: [react(), tailwindcss()],
    server: {
        proxy: {
            "/api": process.env.DASHBOARD_API ?? "http://localhost:8080",
        },
    },
    build: {
        target: "es2022",
        // One ~190 kB (gzipped) bundle, mostly @moq/net, served from the container
        // over localhost -- not worth code-splitting.
        chunkSizeWarningLimit: 1000,
    },
});
