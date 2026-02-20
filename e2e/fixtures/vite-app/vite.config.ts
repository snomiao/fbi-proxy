import { defineConfig } from "vite";

export default defineConfig(() => {
  // Get port from env, fallback to letting vite choose
  const port = process.env.VITE_PORT
    ? parseInt(process.env.VITE_PORT)
    : undefined;
  const hmrHost = process.env.VITE_HMR_HOST;

  return {
    server: {
      host: "127.0.0.1",
      port,
      strictPort: !!port,
      hmr: hmrHost
        ? {
            // When behind proxy, configure HMR to use the proxy-friendly URL
            host: hmrHost,
            clientPort: port,
          }
        : true,
    },
  };
});
