## 🧩 Using `stealth-api` with **ExpressJS**

You can drop `StealthAPI` into an Express server as a lightweight **backend proxy** (security gateway), centralizing
your proxy pool, device headers, and retries — so your frontend stays clean.

### 1) Basic pass‑through route
```ts
import express from "express";
import { StealthAPI } from "stealth-api";

const app = express();
app.use(express.json());

// 1) Construct once (global settings)
const api = new StealthAPI({
  baseURL: "https://example.com/api",
  timeoutMs: 15000,
  retries: 2,
  proxyPool: {
    proxies: [
      { host: "127.0.0.1", port: 8080, protocol: "http" },
      { host: "10.0.0.10", port: 3128, protocol: "http" }
    ],
    rotation: "round-robin",
    stickyKey: "endpoint",
    banOnError: true,
    banDurationMs: 60_000
  }
});

// 2) Pass-through with optional per-request override from query/body
app.get("/proxy/status", async (req, res) => {
  try {
    const usePool = req.query.pool === "1";
    const data = await api.get("/status", {
      useProxyPool: usePool,
      params: { region: (req.query.region as string) || "us" }
    });
    res.json({ ok: true, data });
  } catch (e: any) {
    res.status(502).json({ ok: false, error: e?.message ?? "upstream error" });
  }
});

app.listen(3000, () => console.log("Gateway listening on http://localhost:3000"));
```
**Why this design?** You keep **proxy selection and retries** in the server (trusted environment), while your frontend
just calls `/proxy/status?region=...&pool=1`.

---

### 2) Endpoint registry + aliases
```ts
// register once at startup
api.registerEndpoint("intel", {
  url: "/intel",
  headers: { "x-api-client": "gateway" },
  useProxyPool: true // defaults to pool
});

app.get("/intel", async (_req, res) => {
  try {
    const intel = await api.get("intel"); // uses endpoint defaults
    res.json({ intel });
  } catch (e: any) {
    res.status(502).json({ error: e?.message ?? "upstream error" });
  }
});
```

---

### 3) Request-level proxy override from headers or query
```ts
app.post("/login", async (req, res) => {
  try {
    const proxyHost = (req.headers["x-proxy-host"] as string) || undefined;
    const proxyPort = Number(req.headers["x-proxy-port"] || 0) || undefined;

    const data = await api.post("/login", req.body, {
      proxy: proxyHost && proxyPort ? { host: proxyHost, port: proxyPort, protocol: "http" } : undefined,
      timeoutMs: 20_000
    });

    res.json({ ok: true, data });
  } catch (e: any) {
    res.status(401).json({ ok: false, error: e?.message ?? "auth failed" });
  }
});
```
> **Tip:** Validate/whitelist proxy origins before honoring client-provided overrides.

---

### 4) Weighted devices for header shaping (server-chosen)
```ts
// Load a device catalog (JSON), pick weighted device once per request
import deviceCatalog from "./devices-current-year.json" assert { type: "json" };

function pickWeightedDevice(devices) {
  const expanded = devices.flatMap(d => Array(Math.max(1, d.weight ?? 1)).fill(d));
  return expanded[Math.floor(Math.random() * expanded.length)];
}

app.get("/news", async (_req, res) => {
  try {
    const device = pickWeightedDevice(deviceCatalog.devices);
    const data = await api.get("/news", {
      headers: {
        "user-agent": device.userAgent,
        ...(device.headers ?? {})
      },
      useProxyPool: true
    });
    res.setHeader("x-device-name", device.name);
    res.json(data);
  } catch (e: any) {
    res.status(502).json({ error: e?.message ?? "upstream error" });
  }
});
```
**Reasoning:** Centralize **device emulation** at the server; rotate UA/platform based on the *current-year* popular devices JSON.

---

### 5) Cookie injection (owned sessions only)
```ts
app.get("/me", async (req, res) => {
  try {
    // Example of reconstructing a Cookie header from validated inputs
    const cookieHeader = (req.headers["x-cookie"] as string) || ""; // sanitize in real code
    const me = await api.get("/me", { headers: { Cookie: cookieHeader } });
    res.json(me);
  } catch (e: any) {
    res.status(401).json({ error: e?.message ?? "unauthorized" });
  }
});
```
> **Security:** Only accept cookies from authenticated clients you control. Do not forward untrusted cookies.

---

### 6) Error policy & telemetry
`stealth-api` retries transient codes (`429/502/503/504`) with exponential backoff. In Express, you can surface context:

```ts
app.get("/sometimes-flaky", async (_req, res) => {
  try {
    const data = await api.get("/flaky", { retries: 4, timeoutMs: 10_000, useProxyPool: true });
    res.json({ data });
  } catch (e: any) {
    // Optionally log proxy choice or pool metrics here if you enrich StealthAPI
    res.status(502).json({ error: "upstream unavailable", detail: e?.message });
  }
});
```
**Bond aside:** If the target’s lasers heat up, our backoff gets cooler.