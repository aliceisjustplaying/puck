import { join } from "node:path";
import index from "./browser/index.html";

const port = Number(process.env.PORT) || 5341;
const modulePath = join(import.meta.dir, "dist", "flexe-probe-freestanding.wasm");

async function serveModule(): Promise<Response> {
  const file = Bun.file(modulePath);
  if (!(await file.exists())) {
    return new Response(
      "freestanding module not built; run the experiment fetch and build commands first",
      { status: 404 },
    );
  }
  return new Response(file, {
    headers: { "content-type": "application/wasm", "cache-control": "no-store" },
  });
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  development: true,
  routes: {
    "/flexe-probe-freestanding.wasm": serveModule,
    "/*": index,
  },
});

console.log(`ESP32-S3 ELF runner -> http://127.0.0.1:${server.port}`);
