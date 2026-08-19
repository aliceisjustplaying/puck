// scripts/staticSite.ts: a small static file server for the BUILT gallery
// (site/dist/), shared by every headless check that needs to serve it
// (never the live dev server, server.ts - that is a different thing this
// repo already has its own scripts for, e.g. scripts/verify.ts). Extracted
// so scripts/verify-flash-ui.ts and scripts/verify-site-embeds.ts share one
// implementation instead of two copies that would agree on their MIME map
// exactly once and drift from there - the same "one implementation, not
// two" reasoning this repo already applies to its replay mechanism
// (src/replayCore.ts's own header comment).
import { extname, join } from "node:path";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".uf2": "application/octet-stream",
  ".png": "image/png",
  ".mp4": "video/mp4",
  ".gif": "image/gif",
};

// Serves `dist` (a directory, e.g. site/dist/) at "/" on 127.0.0.1:port -
// the same mapping Cloudflare Pages uses for a project's build output, and
// the reason every URL this repo's own tooling generates for the built
// gallery (site/build.ts's root-absolute module URLs included) is correct
// against this server too, not just against production.
export function serveDist(dist: string, port: number): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      let path = decodeURIComponent(url.pathname);
      if (path === "/") path = "/index.html";
      const file = Bun.file(join(dist, path));
      if (!(await file.exists())) return new Response("not found", { status: 404 });
      const type = MIME[extname(path)] || "application/octet-stream";
      return new Response(file, { headers: { "content-type": type } });
    },
  });
}
