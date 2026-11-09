import { defineConfig } from "vite";

const API = `http://localhost:${process.env.KRETSA_PORT ?? 7777}`;

export default defineConfig({
  server: {
    port: 5177,
    strictPort: true,
    host: true, // listen on all interfaces (LAN access)
    allowedHosts: ["server.local"], // hostnames (beyond localhost/IPs) the dev server answers to
    proxy: {
      "/api": API,
      "/project": API,
      "/kretsa": API,
      "/ws": { target: API.replace("http", "ws"), ws: true },
    },
  },
});
