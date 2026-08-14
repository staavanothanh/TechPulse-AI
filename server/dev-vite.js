/**
 * Keeps Vite's HMR websocket on the same HTTP server as Express. In
 * middleware mode Vite otherwise creates a standalone fallback transport.
 */
export function createDevViteOptions(httpServer) {
  return {
    server: {
      middlewareMode: true,
      ws: { server: httpServer },
    },
    appType: 'spa',
  }
}
