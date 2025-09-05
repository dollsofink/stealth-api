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
    this._currentCountry = null;
  }

  /**
   * Focus subsequent additions on a country code (e.g., "US").
   * @param {string} country
   * @returns {this}
   */
  country(country) {
    this._currentCountry = country.toUpperCase();
    if (!this._cat[this._currentCountry]) this._cat[this._currentCountry] = {};
    return this;
  }

  /**
   * Add one provider entry for a given proxy type under the current country.
   * @param {"res_rotating"|"res_static"|"dc_rotating"|"dc_static"} type
   * @param {ProviderEntry} entry
   * @returns {this}
   */
  add(type, entry) {
    if (!this._currentCountry) throw new Error("ProxyCatalogBuilder.add: call .country(code) first.");
    const bucket = (this._cat[this._currentCountry][type] ||= []);
    bucket.push(deepClone(entry));
    return this;
  }

  /**
   * Add many entries at once.
   * @param {"res_rotating"|"res_static"|"dc_rotating"|"dc_static"} type
   * @param {ProviderEntry[]} entries
   * @returns {this}
   */
  addMany(type, entries) {
    for (const e of entries) this.add(type, e);
    return this;
  }

  /**
   * Finish the current country section.
   * @returns {this}
   */
  done() {
    this._currentCountry = null;
    return this;
  }

  /**
   * Return an immutable {@link ProxyCatalog}.
   * @returns {ProxyCatalog}
   */
  build() {
    for (const c of Object.keys(pool)) {
      pool[c] = (pool[c] || []).filter(Boolean); // strip null/undefined
    }
    return deepClone(this._cat);
  }
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
