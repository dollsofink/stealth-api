import express from "express";
import { StealthAPI } from "stealth-api";

const app = express();
app.use(express.json());

// 1) Construct once (global settings)
const api = new StealthAPI({
  url: "https://stealthapi.org/api",
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
      params: { region: (req.query.region) || "us" }
    });
    res.json({ ok: true, data });
  } catch (e) {
    res.status(502).json({ ok: false, error: e?.message ?? "upstream error" });
  }
});

app.listen(3000, () => console.log("Gateway listening on http://localhost:3000"));