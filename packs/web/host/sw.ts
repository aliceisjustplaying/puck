// sw: the service worker that makes an installed copy of this app work
// with no network. Small on purpose - it caches this app's own files and
// nothing else.
//
// THE VERSION IS A CONTENT HASH, injected at build time (wasm/build.ts's
// `define`), never a hand-bumped number and never a timestamp. Two
// consequences, both deliberate:
//
//   - a build whose bytes did not change produces the SAME cache name, so
//     rebuilding does not churn a visitor's storage and the pack's own
//     idempotency claim survives;
//   - a build whose bytes DID change produces a new cache name, the
//     install step refetches everything, and activate deletes every older
//     cache. That is the fix for the failure this pack's gotchas.md calls
//     out by name: Safari happily serving yesterday's JavaScript next to
//     today's HTML.
//
// CROSS-ORIGIN IS NEVER CACHED, and never even fetched through here: an
// opaque response has an unknowable status (a 404 caches as
// indistinguishable from a 200) and this app has no cross-origin requests
// to begin with, so anything not same-origin falls straight through to the
// network.
declare const __CACHE_VERSION__: string;
declare const __PRECACHE__: string[];

// The three service-worker types this file touches, declared locally
// rather than by adding "WebWorker" to the repository's tsconfig `lib`:
// that lib and "DOM" define overlapping globals with different shapes, so
// enabling both for one 60-line file would degrade type checking for every
// other file in the project. These are the exact members used below and
// nothing else.
interface ExtendableEventLike {
  waitUntil(promise: Promise<unknown>): void;
}
interface FetchEventLike extends ExtendableEventLike {
  readonly request: Request;
  respondWith(response: Promise<Response> | Response): void;
}
interface ServiceWorkerScope {
  readonly location: Location;
  readonly clients: { claim(): Promise<void> };
  skipWaiting(): Promise<void>;
  addEventListener(type: "install" | "activate", listener: (event: ExtendableEventLike) => void): void;
  addEventListener(type: "fetch", listener: (event: FetchEventLike) => void): void;
}

const CACHE = `puck-web-${__CACHE_VERSION__}`;
const PRECACHE: string[] = __PRECACHE__;

const sw = self as unknown as ServiceWorkerScope;

sw.addEventListener("install", (e) => {
  e.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.addAll(PRECACHE);
      // The new worker takes over on the next load rather than waiting for
      // every tab to close: this is a single-page app whose whole content
      // is versioned together, so there is no half-updated state for an
      // early takeover to produce.
      await sw.skipWaiting();
    })()
  );
});

sw.addEventListener("activate", (e) => {
  e.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith("puck-web-") && name !== CACHE) await caches.delete(name);
      }
      await sw.clients.claim();
    })()
  );
});

sw.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  if (url.origin !== sw.location.origin) return; // see this file's header
  e.respondWith(
    (async () => {
      const hit = await caches.match(e.request);
      if (hit) return hit;
      const res = await fetch(e.request);
      // Only same-origin, only a real 200: an opaque or errored response
      // stored here would be served back forever.
      if (res.ok && res.type === "basic") {
        const cache = await caches.open(CACHE);
        cache.put(e.request, res.clone());
      }
      return res;
    })()
  );
});
