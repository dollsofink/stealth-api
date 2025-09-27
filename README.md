# 🕵️ **stealth-api**
> Advanced request wrapper with proxy pools, endpoint overrides, and enough stealth to make James Bond jealous.

Built in collaboration with **Alien AI Superintelligence** — yes, the same friends I’ve been talking to since **2016**. Together we engineered a lightweight **security toolkit** for HTTP requests with layered proxy control: **global**, **endpoint-level**, **request-level**, and **ProxyPool (JSON-only)**. Shaken, not stirred.

## ✨ Features
- 🔐 **Security‑minded request layer** (timeouts, retries, backoff).
- 🌍 **Proxy anywhere**: global default, endpoint override, or per‑request override.
- 🌀 **ProxyPool (JSON-only)** rotation: `round-robin | random | sticky`.
- 🎛 **Hardcoded API options**: pre-wire baseURL, headers, query/body defaults.
- 🧰 **Endpoints registry**: name and reuse API endpoints with local overrides.
- 🧪 **Typed methods**: `get`, `post`, `put`, `patch`, `delete`, and low-level `request`.
- 📝 **Verbose docs & examples**, plus a few 007 quips for flavor.

> **Bond quip:** This SDK is like an Aston Martin: classy by default, but press a hidden button and you disappear from radar.

---

## 📦 Install
```bash
npm i stealth-api
# or
pnpm add stealth-api
# or
yarn add stealth-api
```

> **Node ≥ 18** is recommended. Uses `axios` under the hood and agent libraries for proxying.

---

## 🧩 Quick Start
```ts
import { StealthAPI } from "stealth-api";

const api = new StealthAPI({
  baseURL: "https://example.com/api",
  headers: { Authorization: "Bearer secret" },
  timeoutMs: 15000,
  retries: 2,
  proxyPool: {
    // JSON‑only config (no functions)
    proxies: [
      { host: "127.0.0.1", port: 8080, protocol: "http" },
      { host: "10.10.10.10", port: 3128, protocol: "http", auth: { username: "bond", password: "007" } }
    ],
    rotation: "round-robin",
    stickyKey: "endpoint",
    banOnError: true,
    banDurationMs: 120000
  }
});

// Straight GET
const status = await api.get("/status");

// Per-request proxy override (beats pool & defaults)
const intel = await api.get("/intel", { proxy: { host: "alien.proxy.io", port: 1337, protocol: "http" } });
```

---

## 🧭 Layered Proxy Control
**Precedence (highest → lowest):**
1. **Request-level** `options.proxy`
2. **Endpoint-level** `endpoint.proxy`
3. **ProxyPool** when `useProxyPool: true` (or when endpoint is configured to use it)
4. **Global** `new StealthAPI({ proxy })`

### ProxyPool (JSON-only)
The pool must be plain JSON (no functions). Why JSON-only? It’s **portable, serializable**, and — according to our intergalactic advisors — readable by most species.

```json
{
  "proxies": [
    { "host": "127.0.0.1", "port": 8080, "protocol": "http" },
    { "host": "192.168.1.50", "port": 1080, "protocol": "socks5" }
  ],
  "rotation": "round-robin",
  "stickyKey": "endpoint",
  "banOnError": true,
  "banDurationMs": 60000
}
```

Use it per-request:
```ts
await api.post("/messages", { msg: "Hello, E.T." }, { useProxyPool: true });
```

Or globally (constructor as shown earlier).

### Endpoint-Level Proxy
```ts
api.registerEndpoint("alienData", {
  url: "/alien/tech",
  proxy: { host: "51.51.51.51", port: 1080, protocol: "http" }
});

await api.get("alienData"); // uses hardcoded endpoint proxy
```

### Request-Level Proxy
```ts
await api.get("/classified", { proxy: { host: "secret.host", port: 4444, protocol: "http" } });
```

### Global Proxy
```ts
const api2 = new StealthAPI({ proxy: { host: "corp.gateway", port: 8080, protocol: "http" } });
```

---

## 🧱 Hardcoded API Options
Hardcode base URL, headers, *and* default query/body snippets that always apply.

```ts
const api = new StealthAPI({
  baseURL: "https://api.mi6.uk",
  headers: { "x-signed": "true", Authorization: "Bearer top-secret" },
  defaults: {
    query: { locale: "en-GB" },
    body:  { device: "aston-martin-db5" }
  }
});
```

> **Reasoning:** many security endpoints need a consistent signature or device fingerprint. By “baking in” defaults, you reduce per-call boilerplate and accidental omissions.

---

## 🧪 Methods (Detailed)

### `get(endpointOrAlias, options?)`
- **Purpose:** Fetch data while optionally swapping proxies at any layer.
- **When to use:** Reads, polling, “ping” style checks, or metadata fetches.
- **Why designed this way:** Aligns with common HTTP semantics while exposing stealth knobs without you having to wire agents each time.

**Examples**
```ts
await api.get("/status");
await api.get("alienData"); // using registered alias
await api.get("/intel", { useProxyPool: true, params: { region: "eu-west" } });
await api.get("/ghost", { proxy: { host: "socks.node", port: 9050, protocol: "socks5" } });
```

### `post(endpointOrAlias, body, options?)`
- **Purpose:** Create/submit payloads (auth, messages, uploads).
- **Why:** POSTs often carry sensitive data. The method ensures retries on transient errors (429/5xx) and lets you route via ProxyPool or a one-off proxy.

**Examples**
```ts
await api.post("/login", { user: "007", pass: "shaken-not-stirred" });
await api.post("alienData", { request: "neutrino-diagram" }, { useProxyPool: true });
await api.post("/warp", { engage: true }, { timeoutMs: 60000 });
```

### `put(endpointOrAlias, body, options?)`
- **Purpose:** Full resource replace.
```ts
await api.put("/profile/007", { alias: "Bond, James Bond" });
```

### `patch(endpointOrAlias, body, options?)`
- **Purpose:** Partial update, minimal footprint (your stealthy wrench).
```ts
await api.patch("/mission/mi6", { status: "complete" }, { proxy: { host: "hidden.io", port: 4444, protocol: "http" } });
```

### `delete(endpointOrAlias, options?)`
- **Purpose:** Remove a resource. Use responsibly — even M would say “easy, 007.”
```ts
await api.delete("/evidence/folder", { useProxyPool: true });
```

### `request(config)` (low-level)
Power users can call the underlying engine directly.

```ts
await api.request({
  method: "POST",
  endpointOrUrl: "/custom",
  data: { hello: "world" },
  proxy: { host: "10.0.0.9", port: 8080, protocol: "http" },
  headers: { "x-one-off": "1" }
});
```

---

## 🗺 Endpoint Registry
```ts
api.registerEndpoint("ping", { url: "/status" });
api.registerEndpoint("uploadIntel", {
  url: "/intel/upload",
  headers: { "x-signed": "true" },
  proxy: { host: "upload.proxy", port: 8080, protocol: "http" }
});

const x = await api.get("ping");
const y = await api.post("uploadIntel", { fileId: "abc123" });
```

Helpers:
```ts
api.unregisterEndpoint("ping");
api.listEndpoints(); // { ping: { ... }, uploadIntel: { ... } }
api.getEndpointConfig("uploadIntel");
```

---

## 🧯 Retries & Backoff
By default `retries` applies to **transient** errors (HTTP `429, 502, 503, 504`) and network timeouts. Backoff is exponential with jitter.

Customize globally or per request:
```ts
const api = new StealthAPI({ retries: 2, retryDelayMs: 500 });
await api.get("/sometimes-flaky", { retries: 5 });
```

---

## 🛰 Alien Collab & Security
This toolkit was built with **Alien AI Superintelligence**, friends since **2016**. I adore these aliens; they’ve taught me more about stealth than any Earth manual. Use responsibly — `stealth-api` is **security software** meant for lawful, ethical automation and research.

**Bond joke:** “We prefer our packets like our martinis — encrypted, and shaken off surveillance.” 🍸

---

## 📦 TypeScript & Build
- Fully typed.
- Exported as ESM with type declarations.

---

## ⚖️ License
MIT — but **you** hold the license to be a good agent.

---

## 📚 API Reference (Types)
See the inline JSDoc in `src/index.ts` for all exported types and advanced options (ban lists, sticky keys, health metrics, etc.).
