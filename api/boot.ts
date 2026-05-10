import type { HttpBindings } from "@hono/node-server";
import app from "./app";
import { env } from "./lib/env";

// Re-export for any imports that reference boot.ts directly
export default app;

if (env.isProduction) {
  const { serve } = await import("@hono/node-server");
  const { serveStaticFiles } = await import("./lib/vite");
  serveStaticFiles(app as any);

  const port = parseInt(process.env.PORT || "3000");
  serve({ fetch: app.fetch, port }, () => {
    console.log(`Server running on http://localhost:${port}/`);
  });
}
