// helpers/api-client.mjs
import axios from "axios";
import { HttpsProxyAgent } from "https-proxy-agent";
import { HttpProxyAgent } from "http-proxy-agent";
import { CookieJar } from "tough-cookie";
import { pick2025UA, buildHeadersForUA } from "./ua.mjs";
import { ProxyDirector } from "./proxy-pool.mjs";

/**
 * @typedef {Object} UAProfile
 * @property {string} uaString                    A complete UA string.
 * @property {string} platform                    e.g., "Windows", "Android", "iOS", "macOS", "Linux".
 * @property {boolean} isMobile                   True if the UA is a mobile device.
 * @property {string} [fullVersion]               Browser full version (optional).
 * @property {Object} [clientHints]               CH values produced alongside the UA (optional).
 */

/**
 * @typedef {Object} ProxyConfig
 * @property {"http"|"https"} protocol            Proxy protocol.
 * @property {string} host                        Proxy host.
 * @property {number} port                        Proxy port.
 * @property {string} [username]                  Optional basic auth username.
 * @property {string} [password]                  Optional basic auth password.
 */

/**
 * A geo selection request understood by a ProxyDirector.
 * Any field may be omitted; the director chooses sensible defaults.
 *
 * @typedef {Object} ProxySelectionOptions
 * @property {string} [country]                   ISO country code (e.g., "US").
 * @property {"res_rotating"|"res_static"|"dc_rotating"|"dc_static"} [type]
 * @property {"random"|"roundRobin"|"sticky"} [strategy]  Strategy for within-country picking.
 * @property {string} [sessionKey]                Value used by "sticky" strategy to keep affinity.
 */

/**
 * The return metadata from a director’s pick operation.
 *
 * @typedef {Object} ProxyPickMeta
 * @property {ProxyConfig} proxyConfig            The proxy chosen for the call.
 * @property {string} country                     Country actually chosen.
 * @property {string} type                        Proxy type actually chosen.
 * @property {string} strategy                    Strategy used.
 * @property {string} [provider]                  Optional provider label.
 * @property {string} [notes]                     Optional human notes.
 */

/**
 * Cookie shape for convenience setters.
 * (We feed a serialized string to tough-cookie internally.)
 *
 * @typedef {Object} CookieInput
 * @property {string} name
 * @property {string} value
 * @property {string} [domain]       // default: request host
 * @property {string} [path]         // default: "/"
 * @property {Date|string|number} [expires]
 * @property {"Strict"|"Lax"|"None"} [sameSite]
 * @property {boolean} [secure]
 * @property {boolean} [httpOnly]
 */

/* --------------------------------- Utils ---------------------------------- */

/**
 * Create a proxy agent (Node-only) suited to the **target** URL scheme.
 * @param {ProxyConfig} proxy
 * @param {string} targetUrl
 * @returns {HttpProxyAgent|HttpsProxyAgent}
 * @private
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

const isBrowser = typeof window !== "undefined" && typeof window.document !== "undefined";

/**
 * Serialize a {@link CookieInput} into a Set-Cookie style string.
 * @param {CookieInput} c
 * @param {string} reqUrl
 * @returns {string}
 * @private
 */
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

/* ---------------------------- ApiPoster (core) ----------------------------- */
/**
 * Generic, reusable HTTP client with:
 *  - realistic UA + Client Hints via `pick2025UA` / `buildHeadersForUA`
 *  - per-call / per-instance / endpoint-level / global proxy selection (explicit or geo-aware)
 *  - unified status/response/error capture
 *  - **Node-only cookie jar** (tough-cookie): set/get/clear cookies, auto send & capture Set-Cookie
 *
 * Proxy precedence (highest → lowest):
 *  1. `options.proxy` passed to `request()`
 *  2. `options.geo` + `options.proxyDirector` (if provided)
 *  3. instance-level `this.proxyDirector` + `options.geo`
 *  4. instance-level `this.proxyDirector` + `this.geo`
 *  5. class-level/global `ApiPoster.#proxyDirector` + `options.geo`
 *  6. class-level/global `ApiPoster.#proxyDirector` + `this.geo`
 *  7. `this.proxy` (fixed per-instance proxy)
 *  8. `ApiPoster.#defaultProxy`
 */
export class ApiPoster {
  /** @type {ProxyConfig|null} */
  static #defaultProxy = null;

  /** @type {ProxyDirector|null} */
  static #proxyDirector = null;

  /**
   * Set process-wide default proxy (used if none provided per-instance or per-call).
   * @param {ProxyConfig|null} proxy
   *
   * @example
   * ApiPoster.setDefaultProxy({ protocol:"http", host:"fixed.dc.net", port:8080, username:"u", password:"p" });
   */
  static setDefaultProxy(proxy) {
    ApiPoster.#defaultProxy = proxy;
  }

  /**
   * Set a process-wide {@link ProxyDirector}. If provided, calls may specify
   * `geo` to pick proxies by country/type/strategy (distribution-aware).
   * @param {ProxyDirector|null} director
   *
   * @example
   * import { ProxyDirector } from "./proxy-pool.mjs";
   * const director = new ProxyDirector({ catalog, countryDistribution });
   * ApiPoster.setProxyDirector(director);
   */
  static setProxyDirector(director) {
    ApiPoster.#proxyDirector = director || null;
  }

  /**
   * @param {Object} cfg
   * @param {string} cfg.url                              - Endpoint base URL
   * @param {UAProfile} [cfg.uaProfile]                  - Optional pre-picked UA
   * @param {Object<string,string|number>} [cfg.headers] - Extra headers to merge
   * @param {string} [cfg.referer]                        - Referer header
   * @param {ProxyConfig} [cfg.proxy]                     - Fixed per-instance proxy (bypasses director)
   * @param {ProxySelectionOptions|null} [cfg.geo]        - Default geo selection for this instance
   * @param {ProxyDirector|null} [cfg.proxyDirector]      - Per-instance director (overrides global)
   * @param {CookieJar|null} [cfg.cookieJar]              - Optional external CookieJar (Node-only)
   * @param {CookieInput[]|string[]} [cfg.cookies]        - Optional initial cookies to seed into jar (Node-only)
   */
  constructor(cfg = {}) {
    if (!cfg.url) throw new Error("ApiPoster: `url` is required");
    this.url = cfg.url;

    this.uaProfile = cfg.uaProfile ?? pick2025UA();
    const baseHeaders = buildHeadersForUA(this.uaProfile, {
      // "Content-Type": "application/json", // default; override as needed
      // "X-Requested-With": "XMLHttpRequest",
      // "Sec-Fetch-Mode": "cors",
      // "Sec-Fetch-Site": "same-site",
    });

    const referer = cfg.referer || (typeof window !== "undefined" ? window.location.href : "");
    this.headers = { ...baseHeaders, Referer: referer, ...(cfg.headers || {}) };

    /** @type {ProxyConfig|null} */
    this.proxy = cfg.proxy ?? ApiPoster.#defaultProxy ?? null;

    /** @type {ProxySelectionOptions|null} */
    this.geo = cfg.geo ?? null;

    /** @type {ProxyDirector|null} */
    this.proxyDirector = cfg.proxyDirector ?? null;

    /** Cookie jar (Node-only). In browsers, cookie methods are no-ops. */
    /** @type {CookieJar|null} */
    this.cookieJar = isBrowser ? null : (cfg.cookieJar || new CookieJar());

    // Seed initial cookies if provided (Node-only)
    if (!isBrowser && this.cookieJar && cfg.cookies?.length) {
      for (const c of cfg.cookies) {
        const str = typeof c === "string" ? c : cookieInputToString(c, this.url);
        this.cookieJar.setCookieSync(str, this.url);
      }
    }

    this.lastStatus = null;
    this.lastResponse = null;
    this.lastError = null;

    /** @type {ProxyPickMeta|null} */
    this.lastProxyUsed = null;
  }

  /* -------------------------- UA Helpers (unchanged) -------------------------- */

  /** Replace UA/CH headers with a fresh random profile. */
  applyRandomUA() {
    this.uaProfile = pick2025UA();
    Object.assign(this.headers, buildHeadersForUA(this.uaProfile));
    return this;
  }

  /**
   * Replace UA/CH headers with a provided profile.
   * @param {UAProfile} profile
   */
  applyUA(profile) {
    this.uaProfile = profile;
    Object.assign(this.headers, buildHeadersForUA(profile));
    return this;
  }

  /** Get last result snapshot. */
  getLastResult() {
    return {
      status: this.lastStatus,
      response: this.lastResponse,
      error: this.lastError,
      proxy: this.lastProxyUsed,
    };
  }

  /* ------------------------------- Cookie API ------------------------------- */
  /**
   * Replace or inject a CookieJar (Node-only). Useful to share a session across clients.
   * In browsers this is a no-op.
   * @param {CookieJar} jar
   * @returns {this}
   *
   * @example
   * const sharedJar = new CookieJar();
   * client.useCookieJar(sharedJar);
   * other.useCookieJar(sharedJar);
   */
  useCookieJar(jar) {
    if (!isBrowser) this.cookieJar = jar || new CookieJar();
    return this;
  }

  /** @returns {CookieJar|null} current jar (Node) or null (browser) */
  getCookieJar() {
    return this.cookieJar;
  }

  /**
   * Set a cookie for `url` (defaults to this.url). Accepts either a Set-Cookie string
   * or a {@link CookieInput} object. Node-only; browser will no-op.
   * @param {string|CookieInput} cookie
   * @param {string} [url]
   * @returns {Promise<this>}
   *
   * @example
   * await client.setCookie({ name:"sid", value:"abc", sameSite:"Lax", secure:true });
   */
  async setCookie(cookie, url = this.url) {
    if (isBrowser) return this;
    if (!this.cookieJar) this.cookieJar = new CookieJar();
    const str = typeof cookie === "string" ? cookie : cookieInputToString(cookie, url);
    await this.cookieJar.setCookie(str, url);
    return this;
  }

  /**
   * Batch set cookies. Node-only.
   * @param {(string|CookieInput)[]} cookies
   * @param {string} [url]
   * @returns {Promise<this>}
   */
  async setCookies(cookies = [], url = this.url) {
    for (const c of cookies) await this.setCookie(c, url);
    return this;
  }

  /**
   * Get cookies for a URL as an array of tough-cookie Cookie objects. Node-only.
   * @param {string} [url]
   * @returns {Promise<import("tough-cookie").Cookie[]>}
   */
  async getCookies(url = this.url) {
    if (isBrowser || !this.cookieJar) return [];
    return new Promise((resolve, reject) => {
      this.cookieJar.getCookies(url, (err, cookies) => (err ? reject(err) : resolve(cookies)));
    });
  }

  /**
   * Build the Cookie request header for a URL. Node-only.
   * @param {string} [url]
   * @returns {Promise<string>} e.g. "sid=abc; prefs=xyz"
   */
  async getCookieHeader(url = this.url) {
    if (isBrowser || !this.cookieJar) return "";
    return new Promise((resolve, reject) => {
      this.cookieJar.getCookieString(url, (err, str) => (err ? reject(err) : resolve(str)));
    });
  }

  /**
   * Clear all cookies in the jar (or only for `url` if supported by your policy). Node-only.
   * @returns {Promise<void>}
   */
  async clearCookies() {
    if (isBrowser || !this.cookieJar) return;
    return new Promise((resolve, reject) => {
      this.cookieJar.removeAllCookies(err => (err ? reject(err) : resolve()));
    });
  }

  /** @private */
  async #applyCookiesToHeaders(callHeaders, url) {
    if (isBrowser || !this.cookieJar) return callHeaders;
    if (!("Cookie" in callHeaders)) {
      const cookieStr = await this.getCookieHeader(url);
      if (cookieStr) callHeaders = { ...callHeaders, Cookie: cookieStr };
    }
    return callHeaders;
  }

  /** @private */
  async #captureSetCookiesFromAxios(headers, url) {
    if (isBrowser || !this.cookieJar) return;
    const setCookies = headers?.["set-cookie"];
    if (Array.isArray(setCookies)) {
      for (const sc of setCookies) {
        try { await this.cookieJar.setCookie(sc, url); } catch { /* ignore */ }
      }
    }
  }

  /** @private */
  async #captureSetCookiesFromFetch(res, url) {
    if (isBrowser || !this.cookieJar) return;
    // Node 18+/undici provides getSetCookie()
    const arr = typeof res.headers.getSetCookie === "function"
      ? res.headers.getSetCookie()
      : (res.headers.get("set-cookie") ? [res.headers.get("set-cookie")] : []);
    for (const sc of arr) {
      if (!sc) continue;
      try { await this.cookieJar.setCookie(sc, url); } catch { /* ignore */ }
    }
  }

  /* --------------------------- Proxy resolution (as before) --------------------------- */

  /**
   * Resolve the proxy to use for this request following the precedence rules.
   * Returns `{ proxyConfig: ProxyConfig|null, meta: ProxyPickMeta|null }`.
   *
   * @param {{ proxy?: ProxyConfig|null, geo?: ProxySelectionOptions|null, proxyDirector?: ProxyDirector|null }} options
   * @returns {{ proxyConfig: ProxyConfig|null, meta: ProxyPickMeta|null }}
   * @private
   */
  #resolveProxy(options = {}) {
    const explicitProxy = Object.prototype.hasOwnProperty.call(options, "proxy")
      ? options.proxy
      : undefined;

    if (explicitProxy !== undefined) {
      return { proxyConfig: explicitProxy, meta: null };
    }

    const director = options.proxyDirector ?? this.proxyDirector ?? ApiPoster.#proxyDirector;

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

  /* ------------------------------- HTTP methods ------------------------------- */

  /**
   * Generic request method powering all verb helpers.
   * Follows redirects by default (Axios & Node fetch).
   *
   * @param {"GET"|"POST"|"PUT"|"PATCH"|"DELETE"|"HEAD"|"OPTIONS"} method
   * @param {string} [url]                        Override URL (defaults to `this.url`)
   * @param {any} [body]                          Request body (for verbs that support it)
   * @param {{
   *   proxy?: ProxyConfig|null,
   *   timeoutMs?: number,
   *   headers?: Object<string,string|number>,
   *   geo?: ProxySelectionOptions|null,
   *   proxyDirector?: ProxyDirector|null,
   *   // fetch-only:
   *   credentials?: "omit"|"same-origin"|"include"
   * }} [options]
   * @returns {Promise<this>}
   *
   * @example
   * await client.request("POST", null, { foo: "bar" }, { geo: { country:"US" } });
   */
  async request(method, url = undefined, body = undefined, options = {}) {
    const targetUrl = url || this.url;
    const { timeoutMs = 20000, headers = undefined, credentials = "omit" } = options;

    const { proxyConfig, meta } = this.#resolveProxy(options);
    this.lastProxyUsed = meta;

    this.lastStatus = null;
    this.lastResponse = null;
    this.lastError = null;

    // Merge ad-hoc headers if provided for this call
    let callHeaders = headers ? { ...this.headers, ...headers } : { ...this.headers };

    // Attach cookies (Node only)
    callHeaders = await this.#applyCookiesToHeaders(callHeaders, targetUrl);

    const isBodyVerb = /^(POST|PUT|PATCH|DELETE)$/i.test(method);
    const dataPayload =
      typeof body === "string" || body instanceof Uint8Array || body instanceof ArrayBuffer
        ? body
        : (isBodyVerb ? JSON.stringify(body ?? {}) : undefined);

    // With proxy → Node + axios + proxy agent
    if (proxyConfig) {
      if (isBrowser) {
        const err = new Error("ApiPoster.request: per-request proxy cannot be applied in the browser. Run on Node.");
        this.lastError = err;
        throw err;
      }

      const cfg = {
        method,
        url: targetUrl,
        headers: callHeaders,
        data: dataPayload,
        timeout: timeoutMs,
        proxy: false, // use agent
        maxRedirects: 10,
        validateStatus: () => true,
      };

      const agent = makeProxyAgent(proxyConfig, targetUrl);
      if (String(targetUrl).startsWith("https:")) cfg.httpsAgent = agent;
      else cfg.httpAgent = agent;

      const res = await axios(cfg);
      this.lastStatus = res.status;
      this.lastResponse = res.data;

      // Capture Set-Cookie into jar
      await this.#captureSetCookiesFromAxios(res.headers, targetUrl);

      if (res.status < 200 || res.status >= 300) {
        const msg =
          typeof res.data === "string"
            ? res.data.slice(0, 300)
            : JSON.stringify(res.data ?? "", null, 0).slice(0, 300);
        const err = new Error(`ApiPoster: non-2xx status ${res.status} → ${msg}`);
        this.lastError = err;
        throw err;
      }
      return this;
    }

    // No proxy → prefer fetch (browser or modern Node)
    if (typeof fetch === "function") {
      const init = {
        method,
        headers: callHeaders,
        body: dataPayload,
        credentials,   // in browsers controls cookie sending; in Node it's ignored
        cache: "no-store",
        redirect: "follow",
      };
      // In browsers, sending a "Cookie" header is forbidden—our Node path already set it.
      const res = await fetch(targetUrl, init);
      this.lastStatus = res.status;

      const text = await res.text().catch(() => "");
      let data;
      try { data = JSON.parse(text); } catch { data = text; }
      this.lastResponse = data;

      // Capture Set-Cookie (Node fetch only)
      await this.#captureSetCookiesFromFetch(res, targetUrl);

      if (res.status < 200 || res.status >= 300) {
        const err = new Error(`ApiPoster: non-2xx status ${res.status}`);
        this.lastError = err;
        // throw err;
      }
      return this;
    }

    // Node fallback: axios (no proxy)
    const res = await axios({
      method,
      url: targetUrl,
      headers: callHeaders,
      data: dataPayload,
      timeout: timeoutMs,
      proxy: false,
      maxRedirects: 10,
      validateStatus: () => true,
    });
    this.lastStatus = res.status;
    this.lastResponse = res.data;

    await this.#captureSetCookiesFromAxios(res.headers, targetUrl);

    if (res.status < 200 || res.status >= 300) {
      const err = new Error(`ApiPoster: non-2xx status ${res.status}`);
      this.lastError = err;
      throw err;
    }
    return this;
  }

  /* ------------- Verb sugar (all call through request()) ------------- */

  /** @param {any} [body] @param {any} [opts] */
  post(body, opts) { return this.request("POST", undefined, body, opts); }

  /** @param {any} [opts] */
  get(opts) { return this.request("GET", undefined, undefined, opts); }

  /** @param {any} [body] @param {any} [opts] */
  put(body, opts) { return this.request("PUT", undefined, body, opts); }

  /** @param {any} [body] @param {any} [opts] */
  patch(body, opts) { return this.request("PATCH", undefined, body, opts); }

  /** @param {any} [opts] */
  delete(opts) { return this.request("DELETE", undefined, undefined, opts); }

  /** @param {any} [opts] */
  head(opts) { return this.request("HEAD", undefined, undefined, opts); }

  /** @param {any} [opts] */
  options(opts) { return this.request("OPTIONS", undefined, undefined, opts); }
}

/* -------------------------- Endpoint class factory ------------------------- */
/**
 * Small factory that returns a **named** client class with a baked-in default URL
 * (and optional default headers), while inheriting all behavior from {@link ApiPoster}.
 *
 * Supports endpoint-level defaults:
 *  - `defaultGeo` → used if no per-instance/per-call geo is provided
 *  - `proxyDirector` → endpoint-specific director (overrides global)
 *  - `defaultProxy` → endpoint-specific fixed proxy (skips director)
 *
 * @param {Object} cfg
 * @param {string} cfg.name                         Class name (for debugging)
 * @param {string} cfg.defaultUrl                   Default endpoint
 * @param {Object<string,string|number>} [cfg.defaultHeaders] Default headers to merge at construct time
 * @param {ProxySelectionOptions|null} [cfg.defaultGeo]  Default geo selection for new instances
 * @param {ProxyDirector|null} [cfg.proxyDirector]  Endpoint-level director override
 * @param {ProxyConfig|undefined} [cfg.defaultProxy] Fixed proxy for this endpoint (optional)
 * @returns {typeof ApiPoster} A concrete class you can `new` up.
 *
 * @example
 * const VideoViewClient = makeEndpointClass({
 *   name: "VideoViewClient",
 *   defaultUrl: "https://collector.example.com/view",
 *   defaultHeaders: { "X-App": "view-bot" },
 *   defaultGeo: { type: "res_rotating", strategy: "random" },
 *   proxyDirector: director
 * });
 *
 * const vv = new VideoViewClient();             // uses defaultUrl + endpoint geo + director
 * await vv.post({ id: "abc" });
 */
export function makeEndpointClass({
  name,
  defaultUrl,
  defaultHeaders = {},
  defaultGeo = null,
  proxyDirector = null,
  defaultProxy = undefined,
}) {
  // Named class expression (helps stack traces)
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
      };
      super(merged);
    }
  };
  Object.defineProperty(C, "name", { value: name });
  return C;
}

/* ---------------------------- Endpoint registry --------------------------- */
/**
 * Lightweight registry to manage a “collection” of endpoints.
 * Register once, then create instances by key when needed.
 *
 * @example
 * const endpoints = new EndpointManager();
 * endpoints.register("view", { url: "https://collector.example.com/view" });
 * endpoints.register("adClick", { url: "https://collector.example.com/adclick" });
 *
 * const view = endpoints.create("view");
 * await view.post({ id: "v123" });
 */
export class EndpointManager {
  constructor() {
    /** @type {Map<string, typeof ApiPoster>} */
    this.map = new Map();
  }

  /**
   * Register an endpoint either by:
   *  - passing a class (subclass of ApiPoster), or
   *  - passing a config `{ url, defaultHeaders, defaultGeo, proxyDirector, defaultProxy }`
   *    to auto-make a class via {@link makeEndpointClass}.
   *
   * @param {string} key
   * @param {typeof ApiPoster | {
   *   url: string,
   *   defaultHeaders?: Object<string,string|number>,
   *   defaultGeo?: ProxySelectionOptions|null,
   *   proxyDirector?: ProxyDirector|null,
   *   defaultProxy?: ProxyConfig|undefined
   * }} clsOrCfg
   */
  register(key, clsOrCfg) {
    if (typeof clsOrCfg === "function") {
      this.map.set(key, clsOrCfg);
      return;
    }
    const Klass = makeEndpointClass({
      name: `${key[0].toUpperCase()}${key.slice(1)}Client`,
      defaultUrl: clsOrCfg.url,
      defaultHeaders: clsOrCfg.defaultHeaders || {},
      defaultGeo: clsOrCfg.defaultGeo ?? null,
      proxyDirector: clsOrCfg.proxyDirector ?? null,
      defaultProxy: clsOrCfg.defaultProxy,
    });
    this.map.set(key, Klass);
  }

  /**
   * Create a new client instance for the registered key.
   * Any constructor overrides (`url`, `headers`, `proxy`, `referer`, `uaProfile`, `geo`, `proxyDirector`, `cookieJar`, `cookies`) are accepted.
   *
   * @param {string} key
   * @param {ConstructorParameters<typeof ApiPoster>[0]} [cfg]
   * @returns {ApiPoster}
   */
  create(key, cfg) {
    const Klass = this.map.get(key);
    if (!Klass) throw new Error(`EndpointManager: no endpoint registered for key "${key}"`);
    return new Klass(cfg);
  }

  /**
   * @param {string} key
   * @returns {boolean}
   */
  has(key) {
    return this.map.has(key);
  }

  /**
   * @returns {string[]} keys of registered endpoints
   */
  list() {
    return [...this.map.keys()];
  }
}

/* -------------------------------------------------------------------------- */
/*                          Declarative JSON endpoints                         */
/* -------------------------------------------------------------------------- */

/**
 * JSON schema for declarative endpoint config (minimal doc).
 *
 * {
 *   "useGlobalDirector": true,
 *   "endpoints": [
 *     {
 *       "key": "view",
 *       "name": "VideoViewClient",
 *       "url": "https://collector.example.com/view",
 *       "defaultHeaders": { "X-App": "view-bot" },
 *       "defaultGeo": { "type": "res_rotating", "strategy": "random" }
 *     }
 *   ]
 * }
 */

/**
 * Build an {@link EndpointManager} and (optionally) a class map from a JSON object.
 * You can pass a {@link ProxyDirector} to be used as the default for endpoints
 * that don’t explicitly specify one in the JSON.
 *
 * @param {{
 *   useGlobalDirector?: boolean,
 *   endpoints: Array<{
 *     key: string,
 *     name?: string,
 *     url: string,
 *     defaultHeaders?: Object<string,string|number>,
 *     defaultGeo?: ProxySelectionOptions|null,
 *     defaultProxy?: ProxyConfig|undefined,
 *     directorName?: string
 *   }>
 * }} jsonConfig
 * @param {{
 *   director?: ProxyDirector|null,
 *   directors?: Record<string, ProxyDirector>,
 *   setGlobalDirector?: boolean
 * }} [opts]
 *
 * @returns {{
 *   manager: EndpointManager,
 *   classes: Record<string, typeof ApiPoster>
 * }}
 */
export function buildEndpointsFromJson(jsonConfig, opts = {}) {
  const manager = new EndpointManager();
  const classes = {};

  const directorDefault = opts.director ?? null;
  const directorsMap = opts.directors ?? {};

  if (opts.setGlobalDirector && directorDefault) {
    ApiPoster.setProxyDirector(directorDefault);
  }

  for (const ep of jsonConfig.endpoints || []) {
    const name = ep.name || `${ep.key[0].toUpperCase()}${ep.key.slice(1)}Client`;
    const directorForEp = ep.directorName
      ? (directorsMap[ep.directorName] || directorDefault || null)
      : (directorDefault || null);

    const Klass = makeEndpointClass({
      name,
      defaultUrl: ep.url,
      defaultHeaders: ep.defaultHeaders || {},
      defaultGeo: ep.defaultGeo ?? null,
      proxyDirector: directorForEp,
      defaultProxy: ep.defaultProxy,
    });

    manager.register(ep.key, Klass);
    classes[ep.key] = Klass;
  }

  return { manager, classes };
}
