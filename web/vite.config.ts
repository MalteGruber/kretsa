import { defineConfig } from "vite";

const API = `http://localhost:${process.env.WIBER_PORT ?? 7777}`;

export default defineConfig({
  server: {
    port: 5177,
    strictPort: true,
    host: true, // listen on all interfaces (LAN access)
    proxy: {
      "/api": API,
      "/project": API,
      "/wiber": API,
      "/ws": { target: API.replace("http", "ws"), ws: true },
    },
  },
});
