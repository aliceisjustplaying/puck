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
  // The ESP32-S3 pack's merged flash images (site/flash-artifacts/esp32/).
  // Explicit rather than left to the fallback below, for the same reason
  // .uf2 is: a firmware artifact's content type is part of what the flash
  // page depends on, not an accident of this map's default.
  ".bin": "application/octet-stream",
  ".png": "image/png",
  ".mp4": "video/mp4",
  ".gif": "image/gif",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json",
  // The web device pack's host build emits these two (packs/web/wasm/
  // build.ts): a manifest served as anything else is ignored by Chrome's
  // install path, and an icon served as octet-stream never renders, so a
  // local check of an installable page would pass while production
  // behaved differently.
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
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
      // Directory requests resolve to that directory's index.html, which
      // is what Cloudflare Pages does and what the web device pack's own
      // app pages depend on: they are served at /web/<app>/, a directory
      // URL, and their manifest declares "start_url": "./". A server that
      // only special-cased "/" would 404 them here while production served
      // them fine, which is the worst shape a local check can have.
      if (path.endsWith("/")) path += "index.html";
      const file = Bun.file(join(dist, path));
      if (!(await file.exists())) return new Response("not found", { status: 404 });
      const type = MIME[extname(path)] || "application/octet-stream";
      return new Response(file, { headers: { "content-type": type } });
    },
  });
}
