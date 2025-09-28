// helpers/proxy-pool.mjs

/**
 * @module proxy-pool
 * Tools for building a geo-aware proxy catalog and selecting proxies
 * by country/type/strategy (random/roundRobin/sticky).
 *
 * Works with helpers/api-client.mjs (ApiPoster / EndpointManager).
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
 * A provider entry in the catalog.
 * `endpoint` may contain `${session}` tokens in username/password/host that get expanded
 * by the director for sticky or per-call session affinity.
 *
 * @typedef {Object} ProviderEntry
 * @property {string} [provider]             Human/provider label (e.g., "Webshare")
 * @property {string} [notes]                Optional notes
 * @property {ProxyConfig} endpoint          Proxy endpoint template/config
 */

/**
 * Mapping of country → type → ProviderEntry[].
 * Types should be one of:
 *  - "res_rotating" | "res_static" | "dc_rotating" | "dc_static"
 *
 * Example:
 * {
 *   US: {
 *     res_rotating: [ { provider:"Webshare", endpoint:{ protocol:"http", host:"p.webshare.io", port:80, username:"u-${session}", password:"p" } } ]
 *   },
 *   DE: { ... }
 * }
 *
 * @typedef {Record<string, Record<string, ProviderEntry[]>>} ProxyCatalog
 */

/**
 * Country distribution used for "semi-random" geo picking.
 * Numbers will be normalized to sum to 1.0.
 *
 * @typedef {Record<string, number>} CountryDistribution
 */

/* -------------------------------------------------------------------------- */
/*                            Utility: random + misc                           */
/* -------------------------------------------------------------------------- */

function clamp01(n) { return Math.max(0, Math.min(1, Number(n) || 0)); }

/**
 * Normalize a country distribution to sum to 1.0.
 * If all weights are zero/invalid, returns uniform distribution across keys.
 *
 * @param {CountryDistribution} dist
 * @returns {CountryDistribution}
 *
 * @example
 * normalizeDistribution({ US: 0.6, DE: 0.2, IN: 0.2 })
 */
export function normalizeDistribution(dist = {}) {
  const keys = Object.keys(dist);
  if (!keys.length) return {};
  let sum = 0;
  for (const k of keys) sum += clamp01(dist[k]);
  if (sum <= 0) {
    const uniform = 1 / keys.length;
    return Object.fromEntries(keys.map(k => [k, uniform]));
  }
  return Object.fromEntries(keys.map(k => [k, clamp01(dist[k]) / sum]));
}

/**
 * Weighted random choice.
 * @param {Array<{key:string, weight:number}>} entries
 * @returns {string|null}
 * @private
 */
function weightedPick(entries) {
  const weights = entries.map(e => Math.max(0, e.weight || 0));
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return entries.length ? entries[0].key : null;
  let r = Math.random() * total;
  for (let i = 0; i < entries.length; i++) {
    if ((r -= weights[i]) <= 0) return entries[i].key;
  }
  return entries[entries.length - 1]?.key ?? null;
}

/**
 * Deep clone (for catalog immutability on build).
 * @param {any} o
 * @returns {any}
 * @private
 */
function deepClone(o) {
  return o == null ? o : JSON.parse(JSON.stringify(o));
}

/**
 * Expand `${session}` token in proxy fields.
 * @param {ProxyConfig} cfg
 * @param {string} session
 * @returns {ProxyConfig}
 * @private
 */
function applySessionToken(cfg, session) {
  if (!session) return { ...cfg };
  const rep = v => (typeof v === "string" ? v.replaceAll("${session}", String(session)) : v);
  return {
    protocol: cfg.protocol,
    host: rep(cfg.host),
    port: cfg.port,
    username: rep(cfg.username),
    password: rep(cfg.password),
  };
}

// -----------------------------------------------------------------------------
// Helper: sanitizeEntry
// -----------------------------------------------------------------------------

/**
 * Normalize and validate a provider entry to the **canonical** shape.
 * This helper enforces a single, strict input contract and computes an `auth`
 * string when absent (from `username:password`) so the rest of the codebase
 * can assume a uniform structure.
 *
 * Rationale (why a helper at all, in a "thin" builder?):
 * 1) **Early validation beats runtime crashes**: We fail fast on invalid data
 *    (missing protocol/host/port), which prevents downstream errors like
 *    `Cannot read properties of null (reading 'endpoint')` inside pickers.
 * 2) **Uniform contract**: Enforcing the canonical shape here keeps
 *    ProxyDirector/pool logic lean; they never need to branch on variations.
 * 3) **Minimal surface**: We keep the logic tight—only verify required fields
 *    and compute `auth` once. No legacy conversion, no deep normalization.
 *
 * @param {ProviderEntry} entry
 * @returns {ProviderEntry} a minimally sanitized, canonical entry
 * @throws {TypeError} if required fields are missing/invalid
 */
function sanitizeEntry(entry) {
  if (!entry || typeof entry !== "object") {
    throw new TypeError("ProviderEntry must be an object.");
  }
  const { provider, endpoint } = entry;
  if (!provider || typeof provider !== "string") {
    throw new TypeError("ProviderEntry.provider must be a non-empty string.");
  }
  if (!endpoint || typeof endpoint !== "object") {
    throw new TypeError("ProviderEntry.endpoint must be an object.");
  }
  const { protocol, host } = endpoint;
  const port = Number(endpoint.port);

  if (protocol !== "http" && protocol !== "https" && protocol !== "socks5") {
    throw new TypeError(`ProxyEndpoint.protocol must be "http" | "https" | "socks5". Got: ${protocol}`);
  }
  if (!host || typeof host !== "string") {
    throw new TypeError("ProxyEndpoint.host must be a non-empty string.");
  }
  if (!Number.isFinite(port) || port <= 0) {
    throw new TypeError(`ProxyEndpoint.port must be a positive number. Got: ${endpoint.port}`);
  }

  // Compute auth if not supplied explicitly
  const username = endpoint.username ?? undefined;
  const password = endpoint.password ?? undefined;
  const auth = endpoint.auth ?? (username && password ? `${username}:${password}` : undefined);

  // Return a thin, canonical object (no extra fields)
  return {
    provider: provider.trim(),
    endpoint: {
      protocol,
      host,
      port,
      username,
      password,
      auth,
    },
  };
}


/* -------------------------------------------------------------------------- */
/*                          ProxyCatalogBuilder (optional)                     */
/* -------------------------------------------------------------------------- */

/**
 * Fluent builder to create a {@link ProxyCatalog} programmatically.
 *
 * @example
 * const catalog = new ProxyCatalogBuilder()
 *   .country("US")
 *     .add("res_rotating", { provider:"Webshare", endpoint:{ protocol:"http", host:"p.webshare.io", port:80, username:"user-${session}", password:"pass" } })
 *     .add("dc_rotating", { provider:"MyDC", endpoint:{ protocol:"http", host:"rot.dc.example", port:8080, username:"dc-${session}", password:"pw" } })
 *     .done()
 *   .country("DE")
 *     .add("res_rotating", { provider:"Webshare-DE", endpoint:{ protocol:"http", host:"de.webshare.io", port:80, username:"de-${session}", password:"pass" } })
 *     .done()
 *   .build();
 */
export class ProxyCatalogBuilder {
  constructor() {
    /** @type {ProxyCatalog} */
    this._cat = {};
    /** @type {string|null} */
    this._currentCountry = null;
  }

  /**
   * Focus subsequent additions on a country (ISO code, e.g., "US").
   * @param {string} country
   * @returns {this}
   */
  country(country) {
    if (!country || typeof country !== "string") {
      throw new TypeError("country(code) requires a non-empty string.");
    }
    this._currentCountry = country.toUpperCase();
    if (!this._cat[this._currentCountry]) this._cat[this._currentCountry] = {};
    return this;
  }

  /**
   * Add one provider entry under the current country.
   * @param {ProxyType} type
   * @param {ProviderEntry} entry - canonical shape only
   * @returns {this}
   */
  add(type, entry) {
    if (!this._currentCountry) {
      throw new Error("ProxyCatalogBuilder.add: call .country(code) first.");
    }
    if (type !== "res_rotating" && type !== "res_static" && type !== "dc_rotating" && type !== "dc_static") {
      throw new TypeError(`Unknown proxy type: ${String(type)}`);
    }

    const clean = sanitizeEntry(entry);
    const bucket = (this._cat[this._currentCountry][type] ||= []);
    bucket.push(clean);
    return this;
  }

  /**
   * Add many provider entries under the current country.
   * @param {ProxyType} type
   * @param {ProviderEntry[]} entries - canonical shape only
   * @returns {this}
   */
  addMany(type, entries) {
    if (!Array.isArray(entries)) {
      throw new TypeError("addMany expects an array of ProviderEntry.");
    }
    for (const e of entries) this.add(type, e);
    return this;
  }

  /**
   * Finish the current country section.
   * (Optional; you can switch countries by calling .country(next) directly.)
   * @returns {this}
   */
  done() {
    this._currentCountry = null;
    return this;
  }

  /**
   * Build an immutable catalog for consumption by ProxyDirector.
   * Kept intentionally simple: we already validated everything at `add()`, so
   * `build()` just deep-clones and freezes to guard against accidental mutation.
   *
   * @returns {ProxyCatalog}
   */
  build() {
    const clone = (v) => JSON.parse(JSON.stringify(v)); // thin deep clone for plain data
    /** @type {ProxyCatalog} */
    const out = clone(this._cat);

    // Freeze top-level country/type maps for safety; entries remain plain objects.
    for (const c of Object.keys(out)) {
      Object.freeze(out[c]);
    }
    return Object.freeze(out);
  }
}

/**
 * Normalize a provider entry to the canonical shape:
 *    { provider?: string, endpoint: { protocol, host, port, username?, password?, auth? } }
 *
 * Accepts two input forms:
 *  1) **Canonical** (preferred):
 *     { provider:"Webshare", endpoint:{ protocol:"http", host:"p.webshare.io", port:80, username:"u", password:"p" } }
 *
 *  2) **Legacy flat** (back-compat):
 *     { protocol:"http", host:"p.webshare.io", port:80, username:"u", password:"p", provider?:"Webshare" }
 *
 * Why this helper exists (reasoning):
 * - **Resilience**: Earlier code sometimes pushed `null` or “flat” objects
 *   straight into the pool. When `pickProxy()` later reads `entry.endpoint`,
 *   a null slot explodes. Normalizing up-front ensures every slot either has
 *   a valid `endpoint` or is culled.
 * - **Backwards compatibility**: Your codebase (and past snippets) used both
 *   shapes. This helper lets the builder accept both styles so callers don’t
 *   break while you migrate call sites.
 * - **Validation**: We require `endpoint.protocol`, `endpoint.host`, and a
 *   numeric `endpoint.port`. Entries missing these are filtered out during
 *   `build()`, preventing subtle runtime failures.
 *
 * @param {any} entry
 * @returns {ProviderEntry|null} canonical entry or null if irreparable
 */
function normalizeProviderEntry(entry) {
  if (!entry) return null;

  // Already canonical?
  if (entry.endpoint && typeof entry.endpoint === 'object') {
    const ep = entry.endpoint;
    if (!ep.protocol || !ep.host || !ep.port) return null;
    return {
      provider: entry.provider ?? 'custom',
      endpoint: {
        protocol: String(ep.protocol),
        host: String(ep.host),
        port: Number(ep.port),
        username: ep.username ?? undefined,
        password: ep.password ?? undefined,
        auth: ep.auth ?? (ep.username && ep.password ? `${ep.username}:${ep.password}` : undefined),
      },
    };
  }

  // Legacy flat → canonical
  const { protocol, host, port, username, password, auth, provider } = entry;
  if (!protocol || !host || !port) return null;
  return {
    provider: provider ?? 'custom',
    endpoint: {
      protocol: String(protocol),
      host: String(host),
      port: Number(port),
      username: username ?? undefined,
      password: password ?? undefined,
      auth: auth ?? (username && password ? `${username}:${password}` : undefined),
    },
  };
}

/* -------------------------------------------------------------------------- */
/*                               ProxyDirector                                 */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {Object} ProxySelectionOptions
 * @property {string} [country]    ISO-2 code (e.g., "US"). If omitted, director chooses by distribution.
 * @property {"res_rotating"|"res_static"|"dc_rotating"|"dc_static"} [type]  Desired type; falls back to any available.
 * @property {"random"|"roundRobin"|"sticky"} [strategy]  Pool selection strategy. Default "random".
 * @property {string} [sessionKey] Used with "sticky" to pin a user/session to a specific entry.
 */

/**
 * Metadata returned from a pick.
 *
 * @typedef {Object} ProxyPickMeta
 * @property {ProxyConfig} proxyConfig
 * @property {string} country
 * @property {string} type
 * @property {string} strategy
 * @property {string} [provider]
 * @property {string} [notes]
 */

function firstAvailableType(cRec) {
  if (!cRec) return null;
  const order = ["res_rotating", "res_static", "dc_rotating", "dc_static"];
  for (const t of order) if (Array.isArray(cRec[t]) && cRec[t].length) return t;
  const keys = Object.keys(cRec).filter(k => Array.isArray(cRec[k]) && cRec[k].length);
  return keys[0] || null;
}

/**
 * Chooses proxies by country/type with weighted country distribution, and supports:
 *  - random / roundRobin / sticky (by sessionKey) within a country/type pool
 *  - token substitution ${session} in ProxyConfig fields
 */
export class ProxyDirector {
  /**
   * @param {Object} cfg
   * @param {ProxyCatalog} cfg.catalog
   * @param {CountryDistribution} [cfg.countryDistribution]  Weights per country (normalized internally)
   * @param {"res_rotating"|"res_static"|"dc_rotating"|"dc_static"} [cfg.defaultType="res_rotating"]
   * @param {"random"|"roundRobin"|"sticky"} [cfg.defaultStrategy="random"]
   */
  constructor({ catalog, countryDistribution = {}, defaultType = "res_rotating", defaultStrategy = "random" }) {
    /** @type {ProxyCatalog} */
    this.catalog = deepClone(catalog || {});
    /** @type {CountryDistribution} */
    this.countryDistribution = normalizeDistribution(countryDistribution);
    this.defaultType = defaultType;
    this.defaultStrategy = defaultStrategy;

    /** @type {Record<string, number>} round robin pointer per country+type */
    this._rr = {};
    /** @type {Map<string, {country:string,type:string,index:number}>} sticky map */
    this._sticky = new Map();

    // Build an index for quick pools
    /** @type {Record<string, Record<string, ProviderEntry[]>>} */
    this._pools = this.catalog; // already shaped country->type->array
  }

  /**
   * Update distribution at runtime.
   * @param {CountryDistribution} dist
   * @returns {this}
   *
   * @example
   * director.setCountryDistribution({ US:0.6, IN:0.2, DE:0.2 });
   */
  setCountryDistribution(dist) {
    this.countryDistribution = normalizeDistribution(dist || {});
    return this;
  }

  /**
   * Choose a country honoring configured weights; if none, pick any country present.
   * @returns {string|null}
   * @private
   */
  _pickCountry() {
    const countries = Object.keys(this._pools);
    if (!countries.length) return null;

    const weighted = [];
    for (const c of countries) {
      const w = this.countryDistribution[c];
      weighted.push({ key: c, weight: w != null ? w : 0 });
    }
    const allZero = weighted.every(w => w.weight <= 0);
    if (allZero) return countries[Math.floor(Math.random() * countries.length)];
    return weightedPick(weighted);
  }

  /**
   * Round-robin pointer helper.
   * @param {string} key
   * @param {number} len
   * @returns {number}
   * @private
   */
  _nextRR(key, len) {
    const i = (this._rr[key] = ((this._rr[key] ?? 0) + 1) % len);
    return i;
  }

  /**
   * Pick a proxy using selection options (country/type/strategy/sessionKey).
   * Falls back gracefully when the desired type/country isn’t available.
   *
   * @param {ProxySelectionOptions} [sel]
   * @returns {ProxyPickMeta}
   *
   * @example
   * // Random DE rotating residential
   * director.pickProxy({ country:"DE", type:"res_rotating", strategy:"random" });
   *
   * @example
   * // Sticky US residential rotating by user id
   * director.pickProxy({ country:"US", type:"res_rotating", strategy:"sticky", sessionKey:"user-42" });
   *
   * @example
   * // Country picked by distribution, type default → "res_rotating", strategy default → "random"
   * director.pickProxy();
   */
  pickProxy(sel = {}) {
    const country = (sel.country || this._pickCountry() || Object.keys(this._pools)[0] || "").toUpperCase();
    if (!country || !this._pools[country]) {
      throw new Error("ProxyDirector.pickProxy: no countries available in catalog.");
    }

    // type fallback
    const desiredType = sel.type || this.defaultType;
    const poolType = Array.isArray(this._pools[country][desiredType]) && this._pools[country][desiredType].length
      ? desiredType
      : firstAvailableType(this._pools[country]);
    if (!poolType) throw new Error(`ProxyDirector.pickProxy: no proxy types present for ${country}.`);

    const pool = this._pools[country][poolType];
    if (!Array.isArray(pool) || !pool.length) {
      throw new Error(`ProxyDirector.pickProxy: empty pool for ${country}/${poolType}.`);
    }

    const strategy = sel.strategy || this.defaultStrategy;

    let index = 0;
    if (strategy === "random") {
      index = Math.floor(Math.random() * pool.length);
    } else if (strategy === "roundRobin") {
      index = this._nextRR(`${country}:${poolType}`, pool.length);
    } else if (strategy === "sticky") {
      const key = String(sel.sessionKey || "");
      if (!key) {
        // fallback to round robin if no sessionKey
        index = this._nextRR(`${country}:${poolType}`, pool.length);
      } else {
        const existing = this._sticky.get(key);
        if (existing && existing.country === country && existing.type === poolType && existing.index < pool.length) {
          index = existing.index;
        } else {
          index = Math.floor(Math.random() * pool.length);
          this._sticky.set(key, { country, type: poolType, index });
        }
      }
    } else {
      // unknown strategy → random
      index = Math.floor(Math.random() * pool.length);
    }

    const entry = pool[index];
    if (!entry) {
      throw new Error(`ProxyDirector: empty proxy slot for ${country}[${index}]`);
    }
    if (!entry.endpoint) {
      throw new Error(`ProxyDirector: missing endpoint for ${country}[${index}] -> ${JSON.stringify(entry)}`);
    }
    const sessionKey = sel.sessionKey || "";
    const proxyConfig = applySessionToken(entry.endpoint, sessionKey);

    return {
      proxyConfig,
      country,
      type: poolType,
      strategy,
      provider: entry.provider,
      notes: entry.notes,
    };
  }
}

/* -------------------------------------------------------------------------- */
/*                     Declarative JSON → ProxyDirector loader                 */
/* -------------------------------------------------------------------------- */

/**
 * JSON schema (shape) for building a ProxyDirector declaratively:
 *
 * {
 *   "distribution": { "US": 0.55, "IN": 0.2, "DE": 0.15, "BR": 0.1 },
 *   "defaultType": "res_rotating",
 *   "defaultStrategy": "random",
 *   "countries": {
 *     "US": {
 *       "res_rotating": [
 *         { "provider":"Webshare", "notes":"main", "endpoint": { "protocol":"http","host":"p.webshare.io","port":80, "username":"user-${session}", "password":"pass" } }
 *       ],
 *       "dc_rotating": [
 *         { "provider":"DCNet", "endpoint": { "protocol":"http","host":"rot.dc.example","port":8080, "username":"dc-${session}", "password":"pw" } }
 *       ]
 *     },
 *     "DE": {
 *       "res_rotating": [
 *         { "provider":"Webshare-DE", "endpoint": { "protocol":"http","host":"de.webshare.io","port":80,"username":"de-${session}","password":"pass" } }
 *       ]
 *     }
 *   }
 * }
 *
 * Notes:
 *  - `${session}` token in endpoint fields is replaced by the director when picking.
 *  - Missing distribution → uniform among listed countries.
 *  - Missing type in a country → the director falls back to the first available type.
 */

/**
 * Build a {@link ProxyDirector} (and return the catalog) from JSON.
 *
 * @param {{
 *   distribution?: CountryDistribution,
 *   defaultType?: "res_rotating"|"res_static"|"dc_rotating"|"dc_static",
 *   defaultStrategy?: "random"|"roundRobin"|"sticky",
 *   countries: ProxyCatalog
 * }} json
 * @returns {{ director: ProxyDirector, catalog: ProxyCatalog }}
 *
 * @example
 * import proxyCfg from "../proxies.json" with { type:"json" };
 * const { director, catalog } = buildProxyDirectorFromJson(proxyCfg);
 * // Optionally, set it globally:
 * // ApiPoster.setProxyDirector(director);
 */
export function buildProxyDirectorFromJson(json) {
  if (!json || !json.countries) throw new Error("buildProxyDirectorFromJson: `countries` is required.");
  const catalog = deepClone(json.countries);
  const distribution = normalizeDistribution(json.distribution || {});
  const defaultType = json.defaultType || "res_rotating";
  const defaultStrategy = json.defaultStrategy || "random";
  const director = new ProxyDirector({
    catalog,
    countryDistribution: distribution,
    defaultType,
    defaultStrategy,
  });
  return { director, catalog };
}

/* -------------------------------------------------------------------------- */
/*                                   Examples                                  */
/* -------------------------------------------------------------------------- */

/**
 * @example Programmatic build (builder):
 * import { ProxyCatalogBuilder, ProxyDirector } from "./proxy-pool.mjs";
 *
 * const catalog = new ProxyCatalogBuilder()
 *   .country("US")
 *     .add("res_rotating", { provider:"Webshare", endpoint:{ protocol:"http", host:"p.webshare.io", port:80, username:"user-${session}", password:"pass" } })
 *     .done()
 *   .country("DE")
 *     .add("res_rotating", { provider:"Webshare-DE", endpoint:{ protocol:"http", host:"de.webshare.io", port:80, username:"de-${session}", password:"pass" } })
 *     .done()
 *   .build();
 *
 * const director = new ProxyDirector({
 *   catalog,
 *   countryDistribution: { US:0.6, DE:0.4 },
 *   defaultType: "res_rotating",
 *   defaultStrategy: "random"
 * });
 *
 * const pick = director.pickProxy({ strategy:"sticky", sessionKey:"user-42" });
 * // pick.proxyConfig => usable ProxyConfig with ${session} expanded
 */

/**
 * @example Declarative JSON build:
 * // proxies.json
 * // {
 * //   "distribution": { "US":0.55, "IN":0.2, "DE":0.15, "BR":0.1 },
 * //   "defaultType": "res_rotating",
 * //   "defaultStrategy": "roundRobin",
 * //   "countries": {
 * //     "US": {
 * //       "res_rotating": [
 * //         { "provider":"Webshare", "endpoint": { "protocol":"http","host":"p.webshare.io","port":80,"username":"user-${session}","password":"pass" } }
 * //       ]
 * //     },
 * //     "IN": {
 * //       "res_rotating": [
 * //         { "provider":"Webshare-IN", "endpoint": { "protocol":"http","host":"in.webshare.io","port":80,"username":"in-${session}","password":"pass" } }
 * //       ]
 * //     }
 * //   }
 * // }
 *
 * import cfg from "../proxies.json" with { type:"json" };
 * import { buildProxyDirectorFromJson } from "./proxy-pool.mjs";
 *
 * const { director } = buildProxyDirectorFromJson(cfg);
 * const meta = director.pickProxy({ country:"US", strategy:"random" });
 * // meta.proxyConfig → ready for ApiPoster.post({..}, { proxy: meta.proxyConfig })
 */
