// helpers/api-client.mjs
import http from "node:http";
import https from "node:https";
import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { HttpsProxyAgent } from "https-proxy-agent";
import { HttpProxyAgent } from "http-proxy-agent";
import { CookieJar } from "tough-cookie";
import { pick2025UA, buildHeadersForUA } from "./ua.mjs";
import { ProxyDirector } from "./proxy-pool.mjs";

/**
 * @module helpers/api-client
 *
 * A thin, standardized HTTP client with:
 *  - realistic UA + Client Hints (2025 profiles),
 *  - cookie jar (Node) with auto Set-Cookie capture,
 *  - proxy via fixed config or geo-aware {@link ProxyDirector},
 *  - built-in HAR capture for **raw HTTP** and **Puppeteer**,
 *  - optional **Puppeteer** engine (headers, proxy & cookies synced),
 *  - a **fluent chain** that can mix HTTP and Puppeteer steps and is awaitable.
 *
 * Design goals:
 *  - Zero axios (no mergeConfig/header-bucket pitfalls).
 *  - Immutable-safe header maps (null-prototype POJOs).
 *  - Same public API across transports.
 */

/* ===========================================================================
 * Types
 * ======================================================================== */

/**
 * @typedef {Object} UAProfile
 * @property {string} uaString
 * @property {"desktop"|"mobile"|"tablet"} deviceCategory
 * @property {"Windows"|"macOS"|"Linux"|"Android"|"iOS"} osName
 * @property {string} browserName
 * @property {string} browserVersion
 * @property {{width:number,height:number}} viewport
 * @property {number} dpr
 * @property {number} hardwareConcurrency
 * @property {number} deviceMemoryGB
 * @property {string|null} model
 * @property {string|null} vendor
 * @property {Record<string,string>|null} clientHints
 */

/**
 * @typedef {Object} ProxyConfig
 * @property {"http"|"https"} protocol
 * @property {string} host
 * @property {number} port
 * @property {string} [username]
 * @property {string} [password]
 */

/**
 * @typedef {Object} ProxySelectionOptions
 * @property {string} [country]
 * @property {"res_rotating"|"res_static"|"dc_rotating"|"dc_static"} [type]
 * @property {"random"|"roundRobin"|"sticky"} [strategy]
 * @property {string} [sessionKey]
 */

/**
 * @typedef {Object} ProxyPickMeta
 * @property {ProxyConfig} proxyConfig
 * @property {string} country
 * @property {string} type
 * @property {string} strategy
 * @property {string} [provider]
 * @property {string} [notes]
 */

/**
 * @typedef {Object} CookieInput
 * @property {string} name
 * @property {string} value
 * @property {string} [domain]
 * @property {string} [path]
 * @property {Date|string|number} [expires]
 * @property {"Strict"|"Lax"|"None"} [sameSite]
 * @property {boolean} [secure]
 * @property {boolean} [httpOnly]
 */

/**
 * @typedef {Object} HarOptions
 * @property {"request"|"session"} [scope="session"]   - Raw HTTP only. "request" writes one file per call; "session" appends to a single log file.
 * @property {string} [dir="./har"]                    - Directory to write HAR JSON.
 * @property {string} [name]                           - Filename (default auto).
 * @property {(entry: any) => void} [onEntry]          - Callback for each entry before writing/appending.
 *
 * @typedef {Object} PuppeteerHarOptions
 * @property {"session"|"navigation"} [scope="session"] - Session = one continuous log; navigation = auto-rotate on navigations.
 * @property {string} [dir="./har"]                     - Directory for HAR JSON.
 * @property {string} [name]                            - Filename (default auto).
 * @property {(entry: any) => void} [onEntry]           - Optional per-entry hook.
 */

/**
 * @typedef {Object} PuppeteerConfig
 * @property {import("puppeteer").PuppeteerLaunchOptions} [launch]   - Defaults can be provided via makeEndpointClass() as well.
 * @property {import("puppeteer").BrowserConnectOptions} [connect]   - Alternative to launch (if you use existing browser).
 * @property {import("puppeteer").BrowserContextOptions} [context]   - Context options (e.g., userAgent overriding is handled by headers).
 * @property {PuppeteerHarOptions} [har]                              - Default Puppeteer HAR behavior for this instance.
 */

/**
 * @typedef {Object} RequestOptions
 * @property {ProxyConfig|null} [proxy]
 * @property {number} [timeoutMs=20000]
 * @property {Object<string,string|number>} [headers]
 * @property {ProxySelectionOptions|null} [geo]
 * @property {ProxyDirector|null} [proxyDirector]
 * @property {"omit"|"same-origin"|"include"} [credentials="omit"]   - Browser fetch only; ignored in Node.
 * @property {HarOptions|false} [har]         - Per-request override for raw HTTP HAR (false to disable).
 * @property {PuppeteerConfig} [puppeteer]    - Per-request Puppeteer overrides (rare).
 */

/* ===========================================================================
 * Small helpers
 * ======================================================================== */

const isBrowser = typeof window !== "undefined" && typeof window.document !== "undefined";

/**
 * Make a Node proxy agent suitable for the target scheme.
 * @param {ProxyConfig} proxy
 * @param {string} targetUrl
 */
function makeProxyAgent(proxy, targetUrl) {
  const auth =
    proxy.username || proxy.password
      ? `${encodeURIComponent(proxy.username || "")}:${encodeURIComponent(proxy.password || "")}@`
      : "";
  const proxyUrl = `${proxy.protocol}://${auth}${proxy.host}:${proxy.port}`;
  const isHttpsTarget = String(targetUrl).startsWith("https:");
  return isHttpsTarget ? new HttpsProxyAgent(proxyUrl) : new HttpProxyAgent(proxyUrl);
}

/** Create a random-ish file stem. */
function randStem() {
  return `${Date.now()}-${randomBytes(6).toString("hex")}`;
}

/** Normalize any headers-like into a **null-prototype** bag of strings. */
function toPlainHeaders(h) {
  if (!h) return Object.create(null);
  const out = Object.create(null);
  if (typeof h?.forEach === "function") {
    // WHATWG Headers
    h.forEach((v, k) => { out[k] = String(v ?? ""); });
    return out;
  }
  for (const [k, v] of Object.entries(h)) out[k] = String(v ?? "");
  return out;
}

/** Serialize a {@link CookieInput} into a Set-Cookie string. */
function cookieInputToString(c, reqUrl) {
  const u = new URL(reqUrl);
  const parts = [`${c.name}=${c.value}`];
  parts.push(`Domain=${c.domain || u.hostname}`);
  parts.push(`Path=${c.path || "/"}`);
  if (c.expires) {
    const d = new Date(c.expires);
    if (!isNaN(d)) parts.push(`Expires=${d.toUTCString()}`);
  }
  if (c.sameSite) parts.push(`SameSite=${c.sameSite}`);
  if (c.secure) parts.push("Secure");
  if (c.httpOnly) parts.push("HttpOnly");
  return parts.join("; ");
}

/* ===========================================================================
 * Minimal Node HTTP(S) client with redirect following
 * ======================================================================== */

/**
 * Execute a single HTTP(S) request with optional agent and redirect-following.
 * @private
 * @param {Object} p
 * @param {"GET"|"POST"|"PUT"|"PATCH"|"DELETE"|"HEAD"|"OPTIONS"} p.method
 * @param {string} p.url
 * @param {Record<string,string>} p.headers
 * @param {string|Uint8Array|ArrayBuffer|undefined} p.body
 * @param {http.Agent|https.Agent|undefined} p.agent
 * @param {number} p.timeoutMs
 * @param {number} [p.maxRedirects=10]
 * @returns {Promise<{status:number, headers:Record<string,string|string[]>, bodyText:string, finalUrl:string}>}
 */
async function nodeRequest({ method, url, headers, body, agent, timeoutMs, maxRedirects = 10 }) {
  let currentUrl = url;
  let currentMethod = method;

  for (let i = 0; i <= maxRedirects; i++) {
    const res = await new Promise((resolve, reject) => {
      const u = new URL(currentUrl);
      const isHttps = u.protocol === "https:";
      const lib = isHttps ? https : http;

      /** @type {http.RequestOptions} */
      const opts = {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: u.pathname + (u.search || ""),
        method: currentMethod,
        headers,
        agent,
        timeout: timeoutMs,
      };

      const req = lib.request(opts, (r) => {
        const chunks = [];
        r.on("data", (c) => chunks.push(c));
        r.on("end", () => resolve({
          status: r.statusCode || 0,
          headers: r.headers,   // Node emits lowercased header keys
          body: Buffer.concat(chunks)
        }));
      });

      req.on("timeout", () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)));
      req.on("error", reject);

      if (body != null) {
        if (typeof body === "string") req.write(body);
        else if (body instanceof Uint8Array || body instanceof ArrayBuffer) req.write(Buffer.from(body));
      }
      req.end();
    });

    const { status, headers: respHeaders, body: buf } = res;

    // Handle redirects
    if (status >= 300 && status < 400 && respHeaders.location && i < maxRedirects) {
      const nextUrl = new URL(String(respHeaders.location), currentUrl).toString();
      if (status === 303 || ((status === 301 || status === 302) && currentMethod !== "GET" && currentMethod !== "HEAD")) {
        currentMethod = "GET";
        body = undefined;
        delete headers["content-type"]; delete headers["content-length"]; delete headers["transfer-encoding"];
      }
      currentUrl = nextUrl;
      continue;
    }

    return { status, headers: respHeaders, bodyText: buf.toString("utf8"), finalUrl: currentUrl };
  }
  return { status: 310, headers: {}, bodyText: "", finalUrl: url };
}

/* ===========================================================================
 * HAR: Raw HTTP recorder
 * ======================================================================== */

/**
 * A tiny HAR writer for raw HTTP requests.
 * @private
 */
class HttpHar {
  /**
   * @param {HarOptions} [opts]
   */
  constructor(opts = {}) {
    /** @type {HarOptions} */
    this.opts = { scope: "session", dir: "./har", ...opts };
    this.started = false;
    this.file = this.opts.name || `http-${randStem()}.har.json`;
    this.entries = [];
  }

  async #ensureDir() {
    await fs.mkdir(this.opts.dir, { recursive: true }).catch(() => { });
  }

  /** Begin a session log (noop if already begun). */
  async start() {
    if (this.started) return;
    this.started = true;
    await this.#ensureDir();
  }

  /**
   * Push a HAR entry and write depending on scope.
   * @param {any} entry
   */
  async add(entry) {
    if (!this.started) await this.start();
    if (typeof this.opts.onEntry === "function") {
      try { this.opts.onEntry(entry); } catch { }
    }
    if (this.opts.scope === "request") {
      const name = this.opts.name || `http-${randStem()}.har.json`;
      const payload = JSON.stringify({ log: { version: "1.2", creator: { name: "ApiPoster", version: "1.0" }, entries: [entry] } }, null, 2);
      await fs.writeFile(path.join(this.opts.dir, name), payload, "utf8");
    } else {
      this.entries.push(entry);
      const payload = JSON.stringify({ log: { version: "1.2", creator: { name: "ApiPoster", version: "1.0" }, entries: this.entries } }, null, 2);
      await fs.writeFile(path.join(this.opts.dir, this.file), payload, "utf8");
    }
  }
}

/* ===========================================================================
 * Puppeteer: lazy import + HAR
 * ======================================================================== */

/** Lazy import puppeteer (or puppeteer-core) only on demand. */
async function importPuppeteer() {
  try {
    const mod = await import("puppeteer-extra");
    return mod.default ?? mod;
  } catch {
    const core = await import("puppeteer-core");
    return core.default ?? core;
  }
}

/**
 * Minimal HAR recorder for Puppeteer using CDP Network events.
 * Defaults to "session" scope. "navigation" scope rotates file per main-frame navigation.
 * @private
 */
class PuppeteerHar {
  /**
   * @param {import("puppeteer").Page} page
   * @param {PuppeteerHarOptions} [opts]
   */
  constructor(page, opts = {}) {
    this.page = page;
    /** @type {PuppeteerHarOptions} */
    this.opts = { scope: "session", dir: "./har", ...opts };
    this.cdp = null;
    this.started = false;
    this.file = this.opts.name || `pptr-${randStem()}.har.json`;
    this.entries = [];
    this.requests = new Map();
    this.navCounter = 0;
  }

  async #ensureDir() {
    await fs.mkdir(this.opts.dir, { recursive: true }).catch(() => { });
  }

  async start() {
    if (this.started) return;
    await this.#ensureDir();
    this.cdp = await this.page.createCDPSession();
    await this.cdp.send("Network.enable");

    // navigation handling
    if (this.opts.scope === "navigation") {
      this.page.on("framenavigated", async (frame) => {
        if (!frame.parentFrame()) { // main frame
          // flush previous nav to disk
          if (this.entries.length) await this.#flush();
          this.entries = [];
          this.navCounter += 1;
          this.file = this.opts.name || `pptr-nav-${this.navCounter}-${randStem()}.har.json`;
        }
      });
    }

    // capture lifecycle
    this.cdp.on("Network.requestWillBeSent", (e) => {
      const id = e.requestId;
      this.requests.set(id, {
        startedDateTime: new Date().toISOString(),
        request: {
          method: e.request.method,
          url: e.request.url,
          httpVersion: "HTTP/1.1",
          headers: e.request.headers || {},
          queryString: [],
          cookies: [],
          headersSize: -1,
          bodySize: e.request.postData?.length || 0,
          postData: e.request.postData ? { mimeType: e.request.headers["Content-Type"] || "", text: e.request.postData } : undefined
        },
        timings: {},
        _raw: {}
      });
    });

    this.cdp.on("Network.responseReceived", (e) => {
      const r = this.requests.get(e.requestId);
      if (!r) return;
      r._raw.status = e.response.status;
      r._raw.statusText = e.response.statusText;
      r._raw.headers = e.response.headers || {};
      r._raw.remoteIPAddress = e.response.remoteIPAddress || "";
      r._raw.remotePort = e.response.remotePort || 0;
      r._raw.protocol = e.response.protocol || "h2";
      r._raw.mimeType = e.response.mimeType || "";
    });

    this.cdp.on("Network.loadingFinished", async (e) => {
      const r = this.requests.get(e.requestId);
      if (!r) return;
      try {
        const bodyRes = await this.cdp.send("Network.getResponseBody", { requestId: e.requestId }).catch(() => null);
        const text = bodyRes ? (bodyRes.base64Encoded ? Buffer.from(bodyRes.body, "base64").toString("utf8") : bodyRes.body) : "";
        const entry = {
          startedDateTime: r.startedDateTime,
          time: 0,
          request: r.request,
          response: {
            status: r._raw.status || 0,
            statusText: r._raw.statusText || "",
            httpVersion: r._raw.protocol || "h2",
            headers: r._raw.headers || {},
            cookies: [],
            content: { size: text.length, mimeType: r._raw.mimeType || "", text },
            redirectURL: "",
            headersSize: -1,
            bodySize: text.length
          },
          cache: {},
          timings: { send: -1, wait: -1, receive: -1 },
          serverIPAddress: r._raw.remoteIPAddress || "",
          connection: String(r._raw.remotePort || ""),
          pageref: "page_1"
        };
        if (typeof this.opts.onEntry === "function") {
          try { this.opts.onEntry(entry); } catch { }
        }
        this.entries.push(entry);
      } finally {
        this.requests.delete(e.requestId);
        await this.#flush(); // flush-eager: keeps files up to date
      }
    });

    this.started = true;
  }

  async #flush() {
    await this.#ensureDir();
    const payload = JSON.stringify({ log: { version: "1.2", creator: { name: "ApiPoster", version: "1.0" }, entries: this.entries } }, null, 2);
    await fs.writeFile(path.join(this.opts.dir, this.file), payload, "utf8");
  }

  async stop() {
    if (!this.started) return;
    await this.#flush();
    try { await this.cdp.detach(); } catch { }
    this.started = false;
  }
}

/* ===========================================================================
 * ApiPoster core
 * ======================================================================== */

/**
 * Generic, reusable API client.
 */
export class ApiPoster {
  /** @type {ProxyConfig|null} */   static #defaultProxy = null;
  /** @type {ProxyDirector|null} */ static #proxyDirector = null;

  /**
   * Set a process-wide fixed proxy.
   * @param {ProxyConfig|null} proxy
   * @example
   * ApiPoster.setDefaultProxy({ protocol:"http", host:"fixed.dc.net", port:8080 });
   */
  static setDefaultProxy(proxy) { ApiPoster.#defaultProxy = proxy; }

  /**
   * Set a process-wide ProxyDirector.
   * @param {ProxyDirector|null} director
   * @example
   * ApiPoster.setProxyDirector(new ProxyDirector({ catalog, countryDistribution }));
   */
  static setProxyDirector(director) { ApiPoster.#proxyDirector = director || null; }

  /**
   * @param {Object} cfg
   * @param {string} cfg.url
   * @param {UAProfile} [cfg.uaProfile]
   * @param {Object<string,string|number>} [cfg.headers]
   * @param {string} [cfg.referer]
   * @param {ProxyConfig} [cfg.proxy]
   * @param {ProxySelectionOptions|null} [cfg.geo]
   * @param {ProxyDirector|null} [cfg.proxyDirector]
   * @param {CookieJar|null} [cfg.cookieJar]
   * @param {Array<CookieInput|string>} [cfg.cookies]
   * @param {HarOptions} [cfg.har]                    - Default HAR options for raw HTTP.
   * @param {PuppeteerConfig} [cfg.puppeteer]         - Default Puppeteer config.
   */
  constructor(cfg = {}) {
    if (!cfg.url) throw new Error("ApiPoster: `url` is required");
    this.url = cfg.url;

    // UA + headers
    this.uaProfile = cfg.uaProfile ?? pick2025UA();
    const baseHeaders = buildHeadersForUA(this.uaProfile);
    const referer = cfg.referer || (typeof window !== "undefined" ? window.location.href : "");
    /** @type {Record<string,string>} */
    this.headers = { ...baseHeaders, Referer: referer, ...(cfg.headers || {}) };

    // Proxy/Geo
    /** @type {ProxyConfig|null} */ this.proxy = cfg.proxy ?? ApiPoster.#defaultProxy ?? null;
    /** @type {ProxySelectionOptions|null} */ this.geo = cfg.geo ?? null;
    /** @type {ProxyDirector|null} */ this.proxyDirector = cfg.proxyDirector ?? ApiPoster.#proxyDirector ?? null;

    // Cookies
    /** @type {CookieJar|null} */ this.cookieJar = isBrowser ? null : (cfg.cookieJar || new CookieJar());
    if (!isBrowser && this.cookieJar && cfg.cookies?.length) {
      for (const c of cfg.cookies) {
        const str = typeof c === "string" ? c : cookieInputToString(c, this.url);
        this.cookieJar.setCookieSync(str, this.url);
      }
    }

    // HAR (raw HTTP) defaults
    /** @type {HarOptions|null} */ this.harDefaults = cfg.har || null;
    /** @type {HttpHar|null} */ this.harSession = null;

    // Puppeteer defaults/state
    /** @type {PuppeteerConfig|null} */ this.puppeteerDefaults = cfg.puppeteer || null;
    this.browser = null;
    this.context = null;
    this.page = null;
    /** @type {PuppeteerHar|null} */ this.puppeteerHar = null;

    // last result snapshot
    this.lastStatus = null;
    this.lastResponse = null;
    this.lastError = null;
    /** @type {ProxyPickMeta|null} */ this.lastProxyUsed = null;
  }

  /* ---------------- UA helpers ---------------- */

  /** Replace UA/CH with a fresh random profile. */
  applyRandomUA() { this.uaProfile = pick2025UA(); Object.assign(this.headers, buildHeadersForUA(this.uaProfile)); return this; }
  /** Apply a specific UA/CH profile. */
  applyUA(profile) { this.uaProfile = profile; Object.assign(this.headers, buildHeadersForUA(profile)); return this; }

  /** Snapshot of the last call. */
  getLastResult() { return { status: this.lastStatus, response: this.lastResponse, error: this.lastError, proxy: this.lastProxyUsed }; }

  /* ---------------- Cookie API ---------------- */

  /** Share/replace the CookieJar (Node-only). */
  useCookieJar(jar) { if (!isBrowser) this.cookieJar = jar || new CookieJar(); return this; }
  /** @returns {CookieJar|null} */ getCookieJar() { return this.cookieJar; }

  /** Set a single cookie. Node-only; browser no-ops. */
  async setCookie(cookie, url = this.url) {
    if (isBrowser) return this;
    if (!this.cookieJar) this.cookieJar = new CookieJar();
    const str = typeof cookie === "string" ? cookie : cookieInputToString(cookie, url);
    await this.cookieJar.setCookie(str, url);
    return this;
  }

  /** Batch set cookies (Node-only). */
  async setCookies(cookies = [], url = this.url) { for (const c of cookies) await this.setCookie(c, url); return this; }

  /** Get Cookie objects (Node-only). */
  async getCookies(url = this.url) {
    if (isBrowser || !this.cookieJar) return [];
    return new Promise((resolve, reject) => this.cookieJar.getCookies(url, (err, cookies) => err ? reject(err) : resolve(cookies)));
  }

  /** Build Cookie header (Node-only). */
  async getCookieHeader(url = this.url) {
    if (isBrowser || !this.cookieJar) return "";
    return new Promise((resolve, reject) => this.cookieJar.getCookieString(url, (err, str) => err ? reject(err) : resolve(str)));
  }

  /** Clear all cookies (Node-only). */
  async clearCookies() {
    if (isBrowser || !this.cookieJar) return;
    return new Promise((resolve, reject) => this.cookieJar.removeAllCookies(err => err ? reject(err) : resolve()));
  }

  /**
   * Attach Cookie header from jar without mutating original header bag.
   * @private
   */
  async #applyCookiesToHeaders(callHeaders, url) {
    if (isBrowser || !this.cookieJar) return callHeaders;
    const base = toPlainHeaders(callHeaders);
    // if Cookie already present (case-insensitive), do nothing
    for (const k of Object.keys(base)) if (k.toLowerCase() === "cookie") return base;
    const cookieStr = await this.getCookieHeader(url);
    if (!cookieStr) return base;
    const out = Object.create(null);
    for (const [k, v] of Object.entries(base)) out[k] = String(v ?? "");
    out["Cookie"] = cookieStr;
    return out;
  }

  /** Capture Set-Cookie into jar (raw HTTP path). @private */
  async #captureSetCookiesFromRaw(headers, url) {
    if (isBrowser || !this.cookieJar) return;
    const val = headers["set-cookie"];
    const arr = Array.isArray(val) ? val : (val ? [val] : []);
    for (const sc of arr) { try { await this.cookieJar.setCookie(sc, url); } catch { } }
  }

  /* ---------------- Proxy resolution ---------------- */

  /**
   * Resolve proxy for a request according to precedence.
   * @private
   * @param {{ proxy?: ProxyConfig|null, geo?: ProxySelectionOptions|null, proxyDirector?: ProxyDirector|null }} options
   * @returns {{ proxyConfig: ProxyConfig|null, meta: ProxyPickMeta|null }}
   */
  #resolveProxy(options = {}) {
    const explicitProxy = Object.prototype.hasOwnProperty.call(options, "proxy") ? options.proxy : undefined;
    if (explicitProxy !== undefined) return { proxyConfig: explicitProxy, meta: null };

    const director = options.proxyDirector ?? this.proxyDirector ?? null;

    if (director && options.geo) {
      const pick = director.pickProxy(options.geo);
      return { proxyConfig: pick.proxyConfig, meta: pick };
    }
    if (director && this.geo) {
      const pick = director.pickProxy(this.geo);
      return { proxyConfig: pick.proxyConfig, meta: pick };
    }
    if (this.proxy) return { proxyConfig: this.proxy, meta: null };
    if (ApiPoster.#defaultProxy) return { proxyConfig: ApiPoster.#defaultProxy, meta: null };
    return { proxyConfig: null, meta: null };
  }

  /* ---------------- HAR (raw HTTP) API ---------------- */

  /**
   * Enable or update default HAR options for **raw HTTP**.
   * If scope="session", a file is kept open and appended to across requests.
   * Per-request `{ har: false }` disables it for that call.
   *
   * @param {HarOptions|null} opts
   * @returns {this}
   * @example
   * client.setHar({ dir: "./har", scope: "session" });
   */
  setHar(opts) { this.harDefaults = opts || null; return this; }

  /** @private */
  async #ensureHttpHarSession(harOpts) {
    if (!harOpts || harOpts.scope !== "session") return null;
    if (this.harSession) return this.harSession;
    this.harSession = new HttpHar(harOpts);
    await this.harSession.start();
    return this.harSession;
  }

  /**
   * Build a HAR entry for a raw HTTP call.
   * @private
   */
  #buildHttpHarEntry({ started, method, url, reqHeaders, reqBody, status, respHeaders, respText, finalUrl, durationMs }) {
    return {
      startedDateTime: new Date(started).toISOString(),
      time: durationMs,
      request: {
        method, url, httpVersion: "HTTP/1.1",
        headers: Object.entries(reqHeaders || {}).map(([name, value]) => ({ name, value: String(value) })),
        queryString: [],
        cookies: [],
        headersSize: -1,
        bodySize: typeof reqBody === "string" ? reqBody.length : (reqBody ? Buffer.byteLength(reqBody) : 0),
        postData: reqBody != null ? { mimeType: reqHeaders["Content-Type"] || "", text: typeof reqBody === "string" ? reqBody : "" } : undefined
      },
      response: {
        status, statusText: "", httpVersion: "HTTP/1.1",
        headers: Object.entries(respHeaders || {}).map(([name, value]) => ({ name, value: Array.isArray(value) ? value.join(", ") : String(value) })),
        cookies: [],
        content: { size: respText?.length || 0, mimeType: (respHeaders?.["content-type"] || ""), text: respText || "" },
        redirectURL: finalUrl !== url ? finalUrl : "",
        headersSize: -1,
        bodySize: respText?.length || 0
      },
      cache: {},
      timings: { send: -1, wait: -1, receive: -1 },
      pageref: "raw"
    };
  }

  /* ---------------- Puppeteer: ensure, chain, cookies, headers, proxy, HAR ---------------- */

  /**
   * Ensure a Puppeteer browser/page exists using instance defaults + overrides,
   * set UA/headers, set cookies from the jar, and configure proxy.
   * @private
   * @param {PuppeteerConfig} [override]
   */
async #ensurePuppeteer(override = {}) {
    const pptr = await importPuppeteer();
    const cfg = {
      ...(this.puppeteerDefaults || {}),
      ...(override || {})
    };

    // Resolve proxy for browser-level proxy (if any)
    const { proxyConfig } = this.#resolveProxy({});
    const launch = { ...(cfg.launch || {}) };
    const args = [...(launch.args || [])];

    if (proxyConfig) {
      args.push(`--proxy-server=${proxyConfig.protocol}://${proxyConfig.host}:${proxyConfig.port}`);
      launch.args = args;
    }

    // Create or connect to the browser
    if (!this.browser) {
      if (cfg.connect) {
        this.browser = await pptr.connect(cfg.connect);
      } else {
        this.browser = await pptr.launch(launch);
      }
    }

    // Choose the best available context strategy:
    // 1) createIncognitoBrowserContext (Chromium)
    // 2) createBrowserContext (some Puppeteer variants)
    // 3) defaultBrowserContext (fallback) — then use browser.newPage()
    if (!this.context) {
      if (typeof this.browser.createIncognitoBrowserContext === "function") {
        this.context = await this.browser.createIncognitoBrowserContext(cfg.context || {});
      } else if (typeof this.browser.createBrowserContext === "function") {
        this.context = await this.browser.createBrowserContext(cfg.context || {});
      } else {
        // Fallback: keep a handle to the default context if present
        this.context = (typeof this.browser.defaultBrowserContext === "function")
          ? this.browser.defaultBrowserContext()
          : null;
      }
    }

    // Create a page either from the context or directly from the browser
    if (!this.page) {
      if (this.context && typeof this.context.newPage === "function") {
        this.page = await this.context.newPage();
      } else {
        this.page = await this.browser.newPage();
      }

      // If proxy has credentials → authenticate HTTP proxy on this page
      if (proxyConfig && (proxyConfig.username || proxyConfig.password)) {
        try {
          await this.page.authenticate({
            username: proxyConfig.username || "",
            password: proxyConfig.password || ""
          });
        } catch { /* ignore auth errors */ }
      }

      // UA + headers
      const ua = this.headers["User-Agent"] || this.uaProfile.uaString;
      try { await this.page.setUserAgent(ua); } catch { /* some products may not support */ }

      const extra = { ...this.headers };
      delete extra["User-Agent"];
      delete extra["Cookie"]; // never set Cookie header directly
      try { await this.page.setExtraHTTPHeaders(extra); } catch {}

      // Viewport (best effort)
      if (this.uaProfile?.viewport?.width && this.uaProfile?.viewport?.height) {
        try {
          await this.page.setViewport({
            width: this.uaProfile.viewport.width,
            height: this.uaProfile.viewport.height,
            deviceScaleFactor: this.uaProfile?.dpr || 1
          });
        } catch {}
      }

      // Seed cookies from jar for this origin, if any (Node only)
      if (this.cookieJar) {
        try {
          const u = new URL(this.url);
          const origin = `${u.protocol}//${u.host}`;
          const cookies = await this.getCookies(origin);
          if (cookies.length) {
            await this.page.setCookie(...cookies.map(c => ({
              name: c.key, value: c.value,
              domain: c.domain?.startsWith(".") ? c.domain : (c.domain || u.hostname),
              path: c.path || "/",
              expires: c.expires && c.expires instanceof Date
                ? Math.round(c.expires.getTime() / 1000)
                : (typeof c.expires === "number" ? Math.round(c.expires / 1000) : undefined),
              httpOnly: !!c.httpOnly,
              secure: !!c.secure,
              sameSite: c.sameSite && c.sameSite.toLowerCase() !== "none" ? /** @type {'Lax'|'Strict'} */(c.sameSite) : "None"
            })));
          }
        } catch { /* cookie seeding is best-effort */ }
      }

      // Puppeteer HAR (session default). Guard against non-CDP environments.
      const harCfg = cfg.har || { scope: "session" };
      if (harCfg) {
        try {
          this.puppeteerHar = new PuppeteerHar(this.page, harCfg);
          await this.puppeteerHar.start(); // may throw if CDP unsupported (e.g., non-Chromium)
        } catch {
          this.puppeteerHar = null; // silently disable HAR if unsupported
        }
      }
    }

    return { browser: this.browser, context: this.context, page: this.page };
  }

  /**
   * Get accessors for Puppeteer objects (created on-demand).
   * @param {PuppeteerConfig} [override]
   * @returns {Promise<{browser: import("puppeteer").Browser, context: import("puppeteer").BrowserContext, page: import("puppeteer").Page}>}
   * @example
   * const { browser, page } = await client.getPuppeteer();
   * await page.goto("https://example.com");
   */
  async getPuppeteer(override) { return this.#ensurePuppeteer(override); }

  /**
   * Close Puppeteer browser (if started by this client).
   * @example
   * await client.closeBrowser();
   */
  async closeBrowser() {
    try { if (this.puppeteerHar) await this.puppeteerHar.stop(); } catch { }
    try { if (this.page) await this.page.close(); } catch { }
    try { if (this.context) await this.context.close(); } catch { }
    try { if (this.browser) await this.browser.close(); } catch { }
    this.puppeteerHar = null; this.page = null; this.context = null; this.browser = null;
  }

  /* ---------------- Core request (raw HTTP path) ---------------- */

  /**
   * Core request powering verb helpers.
   *
   * NOTE: For Puppeteer navigation, use the fluent chain (see examples) or `getPuppeteer()`.
   *
   * @param {"GET"|"POST"|"PUT"|"PATCH"|"DELETE"|"HEAD"|"OPTIONS"} method
   * @param {string} [url]                      - defaults to this.url
   * @param {any} [body]
   * @param {RequestOptions} [options]
   * @returns {Promise<this>}
   *
   * @example
   * // Simple GET with geo proxy
   * await client.request("GET", null, null, { geo: { country: "US", strategy: "random" } });
   *
   * @example
   * // Per-request HAR file
   * await client.request("POST", "https://example.com/api", { a:1 }, { har: { scope:"request", dir:"./har" } });
   */
  async request(method, url = undefined, body = undefined, options = {}) {
    const targetUrl = url || this.url;
    const { timeoutMs = 20000, headers: headersOpt = undefined } = options;

    const { proxyConfig, meta } = this.#resolveProxy(options);
    this.lastProxyUsed = meta;

    this.lastStatus = null; this.lastResponse = null; this.lastError = null;

    // merge headers
    let callHeaders = Object.create(null);
    for (const [k, v] of Object.entries(this.headers)) callHeaders[k] = String(v ?? "");
    for (const [k, v] of Object.entries(headersOpt || {})) callHeaders[k] = String(v ?? "");

    // cookies (Node)
    callHeaders = await this.#applyCookiesToHeaders(callHeaders, targetUrl);

    // payload
    const isBodyVerb = /^(POST|PUT|PATCH|DELETE)$/i.test(method);
    const dataPayload =
      typeof body === "string" || body instanceof Uint8Array || body instanceof ArrayBuffer
        ? body
        : (isBodyVerb ? JSON.stringify(body ?? {}) : undefined);

    const agent = proxyConfig ? makeProxyAgent(proxyConfig, targetUrl) : undefined;

    const startedTs = Date.now();
    const { status, headers, bodyText, finalUrl } = await nodeRequest({
      method, url: targetUrl, headers: callHeaders, body: dataPayload, agent, timeoutMs
    });

    this.lastStatus = status;
    let data; try { data = JSON.parse(bodyText); } catch { data = bodyText; }
    this.lastResponse = data;

    await this.#captureSetCookiesFromRaw(headers, targetUrl);

    // Raw HTTP HAR
    const harOpts = options.har === false ? null : (options.har || this.harDefaults);
    if (harOpts) {
      const session = await this.#ensureHttpHarSession(harOpts);
      const entry = this.#buildHttpHarEntry({
        started: startedTs, method, url: targetUrl, reqHeaders: callHeaders, reqBody: dataPayload,
        status, respHeaders: headers, respText: bodyText, finalUrl, durationMs: Date.now() - startedTs
      });
      if (session) await session.add(entry);
      else await new HttpHar(harOpts).add(entry);
    }

    if (status < 200 || status >= 300) {
      const snippet = typeof data === "string" ? data.slice(0, 300) : JSON.stringify(data ?? "", null, 0).slice(0, 300);
      const err = new Error(`ApiPoster: non-2xx status ${status} → ${snippet}`);
      this.lastError = err;
      throw err;
    }
    return this;
  }

  /* ---------------- Verb helpers (return fluent chain) ----------------
   *
   * To support `await client.get().evaluate(...).goto(...)`, each verb returns
   * a chain object that is Thenable. Awaiting it executes all queued steps.
   * The chain resolves to the **client instance** (so prior code using
   * `.then((res)=> res.lastStatus)` still works).
   *
   * You can still call the core method directly via `await client.request(...)`.
   * ------------------------------------------------------------------ */

  #makeChain() {
    const self = this;
    /** @type {Array<{kind:"http"|"pptr", run: ()=>Promise<void>}>} */
    const queue = [];

    const thenable = new Proxy({}, {
      get(_t, prop) {
        if (prop === "then") {
          // Promise interoperability: run queue on await/then
          return async (resolve, reject) => {
            try {
              for (const step of queue) await step.run();
              resolve(self); // resolve to client
            } catch (e) { reject(e); }
          };
        }

        // HTTP verbs (chainable)
        if (["get", "post", "put", "patch", "delete", "head", "options"].includes(String(prop))) {
          return (bodyOrOpts, maybeOpts) => {
            const method = String(prop).toUpperCase();
            const body = ["POST", "PUT", "PATCH"].includes(method) ? bodyOrOpts : undefined;
            const opts = ["POST", "PUT", "PATCH"].includes(method) ? (maybeOpts || {}) : (bodyOrOpts || {});
            queue.push({
              kind: "http",
              run: async () => { await self.request(method, undefined, body, opts); }
            });
            return thenable;
          };
        }

        // Any Puppeteer Page method → enqueue a page operation
        return (...args) => {
          queue.push({
            kind: "pptr",
            run: async () => {
              const { page } = await self.#ensurePuppeteer(); // create if needed
              const fn = page[prop];
              if (typeof fn !== "function") throw new Error(`Puppeteer: page.${String(prop)} is not a function`);
              // eslint-disable-next-line no-await-in-loop
              await fn.apply(page, args);
            }
          });
          return thenable;
        };
      }
    });

    return thenable;
  }

  /** @param {any} [opts] */ get(opts) { return this.#makeChain().get(opts); }
  /** @param {any} [body] @param {any} [opts] */ post(body, opts) { return this.#makeChain().post(body, opts); }
  /** @param {any} [body] @param {any} [opts] */ put(body, opts) { return this.#makeChain().put(body, opts); }
  /** @param {any} [body] @param {any} [opts] */ patch(body, opts) { return this.#makeChain().patch(body, opts); }
  /** @param {any} [opts] */ delete(opts) { return this.#makeChain().delete(opts); }
  /** @param {any} [opts] */ head(opts) { return this.#makeChain().head(opts); }
  /** @param {any} [opts] */ options(opts) { return this.#makeChain().options(opts); }
}

/* ===========================================================================
 * Endpoint factory + registry
 * ======================================================================== */

/**
 * Factory for concrete endpoint classes with baked-in defaults.
 *
 * Supports endpoint-level defaults:
 *  - defaultGeo
 *  - proxyDirector
 *  - defaultProxy
 *  - har (raw HTTP) defaults
 *  - puppeteer defaults (launch/context/har)
 *
 * @param {Object} cfg
 * @param {string} cfg.name
 * @param {string} cfg.defaultUrl
 * @param {Object<string,string|number>} [cfg.defaultHeaders]
 * @param {ProxySelectionOptions|null} [cfg.defaultGeo]
 * @param {ProxyDirector|null} [cfg.proxyDirector]
 * @param {ProxyConfig|undefined} [cfg.defaultProxy]
 * @param {HarOptions} [cfg.har]
 * @param {PuppeteerConfig} [cfg.puppeteer]
 * @returns {typeof ApiPoster}
 *
 * @example
 * const VideoClient = makeEndpointClass({
 *   name: "VideoClient",
 *   defaultUrl: "https://www.videos.com",
 *   defaultHeaders: { "accept": "*" },
 *   defaultGeo: { strategy: "random" },
 *   proxyDirector: director,
 *   har: { dir:"./har", scope:"session" },
 *   puppeteer: { launch: { headless: true } }
 * });
 *
 * // Raw HTTP
 * const c1 = new VideoClient();
 * await c1.get({ geo: { country:"US" } });  // awaitable chain
 *
 * // Puppeteer chain
 * await c1
 *   .get()                             // (optional) queue an HTTP call first
 *   .goto("https://example.com")       // puppeteer Page.goto
 *   .evaluate(() => document.title);
 */
export function makeEndpointClass({
  name,
  defaultUrl,
  defaultHeaders = {},
  defaultGeo = null,
  proxyDirector = null,
  defaultProxy = undefined,
  har = undefined,
  puppeteer = undefined,
}) {
  const C = class extends ApiPoster {
    constructor(cfg = {}) {
      const merged = {
        url: cfg.url || defaultUrl,
        headers: { ...(cfg.headers || {}), ...defaultHeaders },
        uaProfile: cfg.uaProfile,
        referer: cfg.referer,
        proxy: (cfg.proxy !== undefined ? cfg.proxy : defaultProxy),
        geo: (cfg.geo !== undefined ? cfg.geo : defaultGeo),
        proxyDirector: (cfg.proxyDirector !== undefined ? cfg.proxyDirector : proxyDirector),
        cookieJar: cfg.cookieJar,
        cookies: cfg.cookies,
        har: cfg.har !== undefined ? cfg.har : har,
        puppeteer: cfg.puppeteer !== undefined ? cfg.puppeteer : puppeteer,
      };
      super(merged);
    }
  };
  Object.defineProperty(C, "name", { value: name });
  return C;
}

/**
 * Minimal endpoint registry.
 */
export class EndpointManager {
  constructor() { /** @type {Map<string, typeof ApiPoster>} */ this.map = new Map(); }

  /**
   * Register a class or a config for makeEndpointClass().
   * @param {string} key
   * @param {typeof ApiPoster | {
   *   url: string,
   *   defaultHeaders?: Object<string,string|number>,
   *   defaultGeo?: ProxySelectionOptions|null,
   *   proxyDirector?: ProxyDirector|null,
   *   defaultProxy?: ProxyConfig|undefined,
   *   har?: HarOptions,
   *   puppeteer?: PuppeteerConfig
   * }} clsOrCfg
   */
  register(key, clsOrCfg) {
    if (typeof clsOrCfg === "function") { this.map.set(key, clsOrCfg); return; }
    const Klass = makeEndpointClass({
      name: `${key[0].toUpperCase()}${key.slice(1)}Client`,
      defaultUrl: clsOrCfg.url,
      defaultHeaders: clsOrCfg.defaultHeaders || {},
      defaultGeo: clsOrCfg.defaultGeo ?? null,
      proxyDirector: clsOrCfg.proxyDirector ?? null,
      defaultProxy: clsOrCfg.defaultProxy,
      har: clsOrCfg.har,
      puppeteer: clsOrCfg.puppeteer
    });
    this.map.set(key, Klass);
  }

  /**
   * Create a client for a key.
   * @param {string} key
   * @param {ConstructorParameters<typeof ApiPoster>[0]} [cfg]
   * @returns {ApiPoster}
   */
  create(key, cfg) {
    const Klass = this.map.get(key);
    if (!Klass) throw new Error(`EndpointManager: no endpoint registered for key "${key}"`);
    return new Klass(cfg);
  }

  /** @returns {boolean} */ has(key) { return this.map.has(key); }
  /** @returns {string[]} */ list() { return [...this.map.keys()]; }
}

/* ===========================================================================
 * Usage snippets (copy/paste)
 * ======================================================================== */

/**
 * ## Examples
 *
 * ### 1) Raw HTTP with geo proxy + HAR (session)
 * ```js
 * const VideoClient = makeEndpointClass({
 *   name: "VideoClient",
 *   defaultUrl: "https://www.videos.com",
 *   defaultHeaders: {
 *     accept: "text/html,application/xhtml+xml,application/xml;q=0.9",
 *     "accept-language": "en-US,en;q=0.9",
 *     "upgrade-insecure-requests": "1",
 *   },
 *   defaultGeo: { strategy: "random" },
 *   proxyDirector: director,
 *   har: { dir: "./har", scope: "session" }
 * });
 *
 * const client = new VideoClient();
 * await client.get({ geo: { country: "US" } });
 * console.log(client.getLastResult()); // {status, response, ...}
 * ```
 *
 * ### 2) Per-request HAR file
 * ```js
 * await client.post({ id:123 }, { har: { scope: "request", dir: "./har" } });
 * ```
 *
 * ### 3) Puppeteer with headers, proxy & cookies (fluent)
 * ```js
 * const client = new VideoClient({
 *   puppeteer: { launch: { headless: true }, har: { scope: "session", dir: "./har" } }
 * });
 *
 * await client
 *   .goto("https://google.com")                      // Puppeteer Page.goto
 *   .evaluate(() => document.title)                  // Page.evaluate
 *   .waitForSelector("input[name=q]");
 *
 * const { page } = await client.getPuppeteer();      // direct access
 * await page.type("input[name=q]", "hello");
 * ```
 *
 * ### 4) Mixed: raw GET then Puppeteer navigation
 * ```js
 * await client
 *   .get({ geo: { country: "US" } })                 // raw HTTP GET first
 *   .goto("https://example.com")                     // then drive browser
 *   .evaluate(() => console.log(window.location.href));
 * ```
 *
 * ### 5) Manual Puppeteer control
 * ```js
 * const { browser, page } = await client.getPuppeteer({ launch: { headless: "new" } });
 * await page.goto("https://example.com");
 * await client.closeBrowser();
 * ```
 */
