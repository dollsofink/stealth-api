// cookies.mjs
// ESM module: a universal cookie normalizer/adapter.
//
// This file is intentionally **framework-agnostic** and pure JS (.mjs).
// It parses a wide variety of cookie inputs (headers, Set-Cookie lines,
// Netscape cookies.txt, CSV/TSV, JSON exports, simple maps, console.log outputs)
// and emits normalized shapes for:
//   - HTTP `Cookie` request header
//   - Puppeteer `page.setCookie(...cookies)`
//   - tough-cookie `Cookie.fromJSON(...)` (+ an optional `intoCookieJar` helper)
//
// ───────────────────────────────────────────────────────────────────────────────
// JSDoc overview
// ───────────────────────────────────────────────────────────────────────────────
// - Every public method includes examples. Copy/paste into your IDE for hints.
// - This module prefers **lawful, owned-session** use only. Do not misuse.
// - No exploits are included. Just parsing, normalization, and helpers.
//
// Usage quickstart:
//   import Cookies from "./cookies.mjs";
//   const jar = new Cookies('Cookie: a=1; b=2');
//   jar.add(`# Netscape HTTP Cookie File\n.example.com\tTRUE\t/\tFALSE\t2082787200\tsid\txyz`);
//   await jar.intoCookieJar(new CookieJar()); // optional (Node)
//
//   const header = jar.headerLine();    // "Cookie: a=1; b=2; sid=xyz"
//   const pupp  = jar.toPuppeteer();    // [...]
//   const tough = jar.toToughJSON();    // [...]
//
// ───────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} NormalCookie
 * @property {string} name
 * @property {string} value
 * @property {string} [domain]
 * @property {string} [path="/"]
 * @property {number|null} [expires]       UNIX seconds or null for session
 * @property {boolean} [httpOnly]
 * @property {boolean} [secure]
 * @property {"Strict"|"Lax"|"None"} [sameSite]
 * @property {boolean} [hostOnly]
 * @property {boolean} [session]
 */

/**
 * @typedef {Object} ParseOptions
 * @property {string} [defaultDomain]  Default domain when missing
 * @property {string} [defaultPath="/"] Default path when missing
 * @property {boolean} [defaultSecure]  Default secure flag
 * @property {string} [url]             Optional URL used to infer domain/path
 */

/** @private */
const BOM = "\\ufeff";

/** @private */
function stripBOM(s) {
  return s.startsWith(BOM) ? s.slice(1) : s;
}

/** @private */
function toUnixSeconds(d) {
  if (d == null) return null;
  if (typeof d === "number") return Math.floor(d);
  const ts = Date.parse(String(d));
  return Number.isFinite(ts) ? Math.floor(ts / 1000) : null;
}

/** @private */
function normSameSite(v) {
  if (!v) return undefined;
  const s = String(v).trim().toLowerCase();
  if (s === "strict") return "Strict";
  if (s === "lax") return "Lax";
  if (s === "none") return "None";
  return undefined;
}

/** @private */
function guessDelimiter(headerLine) {
  const counts = {
    ",": (headerLine.match(/,/g) || []).length,
    "\t": (headerLine.match(/\t/g) || []).length,
    ";": (headerLine.match(/;/g) || []).length
  };
  let max = ",";
  for (const k of Object.keys(counts)) {
    if (counts[k] > counts[max]) max = k;
  }
  return /** @type {","|"\t"|";"} */(max);
}

/** @private Minimal CSV/TSV splitter with quotes */
function splitRow(line, delimiter) {
  const out = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (q && line[i + 1] === '"') { cur += '"'; i++; }
      else { q = !q; }
    } else if (ch === delimiter && !q) {
      out.push(cur); cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/** @private Parse "Cookie: a=1; b=2" or "a=1; b=2" */
function parseCookieHeader(value) {
  const parts = value.split(";").map(s => s.trim()).filter(Boolean);
  const out = [];
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim();
    if (!name) continue;
    out.push({ name, value: val });
  }
  return out;
}

/** @private Parse a single Set-Cookie line */
function parseSetCookie(line) {
  const withoutPrefix = line.trim().toLowerCase().startsWith("set-cookie:")
    ? line.slice(line.indexOf(":") + 1).trim()
    : line.trim();
  const segments = withoutPrefix.split(";");
  const [nameValue, ...attrs] = segments;
  const eq = nameValue.indexOf("=");
  if (eq < 0) return null;
  const name = nameValue.slice(0, eq).trim();
  const value = nameValue.slice(eq + 1).trim();

  /** @type {NormalCookie} */
  const cookie = { name, value };
  for (const raw of attrs) {
    const s = raw.trim();
    const i = s.indexOf("=");
    const key = (i >= 0 ? s.slice(0, i) : s).toLowerCase();
    const val = i >= 0 ? s.slice(i + 1) : "true";
    if (key === "path") cookie.path = val;
    else if (key === "domain") cookie.domain = val;
    else if (key === "expires") cookie.expires = toUnixSeconds(val);
    else if (key === "max-age") cookie.expires = Math.floor(Date.now() / 1000) + (parseInt(val, 10) || 0);
    else if (key === "httponly") cookie.httpOnly = true;
    else if (key === "secure") cookie.secure = true;
    else if (key === "samesite") cookie.sameSite = normSameSite(val);
  }
  return cookie;
}

/** @private Parse Netscape cookies.txt */
function parseNetscapeCookiesTxt(text) {
  // domain<TAB>flag<TAB>path<TAB>secure<TAB>expiration<TAB>name<TAB>value
  const out = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const cols = trimmed.split("\t");
    if (cols.length < 7) continue;
    const [domain, flag, path, secure, expiry, name, value] = cols;
    out.push({
      name, value, domain, path,
      secure: /^true$/i.test(secure) || secure === "TRUE",
      hostOnly: /^false$/i.test(flag) ? false : undefined,
      expires: expiry ? parseInt(expiry, 10) : null
    });
  }
  return out;
}

/** @private Parse CSV/TSV with headers (name,value,domain,path,...) */
function parseCSVorTSV(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const delimiter = guessDelimiter(lines[0]);
  const headers = splitRow(lines[0], delimiter).map(h => h.trim().toLowerCase());
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const row = splitRow(lines[i], delimiter);
    const rec = {};
    headers.forEach((h, idx) => rec[h] = (row[idx] ?? "").trim());
    const name = rec["name"] || rec["key"];
    const value = rec["value"];
    if (!name) continue;
    out.push({
      name,
      value: value ?? "",
      domain: rec["domain"] || rec["host"],
      path: rec["path"] || "/",
      expires: rec["expires"] ? toUnixSeconds(rec["expires"]) : (rec["expiry"] ? parseInt(rec["expiry"], 10) : null),
      httpOnly: /true/i.test(rec["httponly"] || ""),
      secure: /true/i.test(rec["secure"] || ""),
      sameSite: normSameSite(rec["samesite"])
    });
  }
  return out;
}

/** @private */
function isLikelyNetscape(text) {
  return /#\s*Netscape HTTP Cookie File/i.test(text) || /\tTRUE\t|\tFALSE\t/.test(text);
}

/** @private */
function ensureDefaults(c, opt) {
  const out = { ...c };
  if (!out.path) out.path = opt.defaultPath || "/";
  if (out.secure == null && opt.defaultSecure != null) out.secure = opt.defaultSecure;
  if (!out.domain && opt.url) {
    try { out.domain = new URL(opt.url).hostname; } catch {}
  }
  if (!out.domain && opt.defaultDomain) out.domain = opt.defaultDomain;
  return out;
}

/**
 * Universal Cookies adapter.
 *
 * ### Examples
 * ```js
 * import Cookies from "./cookies.mjs";
 *
 * // From a Cookie header
 * const jar1 = new Cookies("Cookie: a=1; b=2");
 *
 * // From Set-Cookie lines (multi-line string)
 * const jar2 = new Cookies(`
 *   Set-Cookie: sid=xyz; Path=/; Domain=example.com; HttpOnly; Secure
 *   Set-Cookie: theme=light; Path=/; Domain=example.com
 * `);
 *
 * // From Netscape cookies.txt
 * const jar3 = new Cookies(`# Netscape HTTP Cookie File
 * .example.com\tTRUE\t/\tFALSE\t2082787200\tsid\txyz`);
 *
 * // From CSV/TSV
 * const jar4 = new Cookies("name,value,domain,path\\nsid,xyz,example.com,/");
 *
 * // From JSON (Puppeteer export)
 * const jar5 = new Cookies({ cookies: [{ name: "sid", value: "xyz", domain: "example.com", path: "/" }] });
 * ```
 */
export default class Cookies {
  /** @private */ #cookies = [];

  /**
   * Create a cookie jar and optionally seed it with **any** supported input.
   *
   * @param {string|Array<any>|Object} [input]
   * @param {ParseOptions} [options]
   *
   * @example
   * // Infer domain/path from URL if missing
   * const jar = new Cookies("a=1; b=2", { url: "https://example.com" });
   */
  constructor(input, options = {}) {
    if (input != null) {
      const list = this.parseAny(input, options);
      this.#cookies = list.map(c => ensureDefaults(c, options));
    }
  }

  /**
   * Add cookies in any supported format.
   * @param {string|Array<any>|Object} input
   * @param {ParseOptions} [options]
   * @returns {this}
   *
   * @example
   * jar.add('Set-Cookie: token=abc; Domain=example.com; Path=/; HttpOnly');
   * @example
   * jar.add({ name: "pref", value: "dark", domain: "example.com" });
   * @example
   * jar.add({ pref: "dark" }); // name/value map
   */
  add(input, options = {}) {
    const list = this.parseAny(input, options).map(c => ensureDefaults(c, options));
    this.#cookies.push(...list);
    return this;
  }

  /**
   * Return normalized JSON array ({@link NormalCookie}).
   * Sorted by domain/name for stable output.
   *
   * @returns {NormalCookie[]}
   * @example
   * console.log(jar.toJSON());
   */
  toJSON() {
    return [...this.#cookies].sort((a, b) => (a.domain || "").localeCompare(b.domain || "") || a.name.localeCompare(b.name));
  }

  /**
   * Return **Cookie request header value** (without the "Cookie: " prefix).
   *
   * @returns {string}
   * @example
   * const value = jar.headerValue(); // "a=1; b=2; sid=xyz"
   */
  headerValue() {
    const map = new Map();
    for (const c of this.#cookies) {
      const key = `${c.domain || ""}|${c.path || ""}|${c.name}`;
      map.set(key, c); // last one wins
    }
    const pairs = [];
    for (const c of map.values()) pairs.push(`${c.name}=${c.value}`);
    return pairs.join("; ");
  }

  /**
   * Return complete **Cookie header line**.
   * @returns {string}
   * @example
   * const line = jar.headerLine(); // "Cookie: a=1; b=2"
   */
  headerLine() {
    const v = this.headerValue();
    return v ? `Cookie: ${v}` : "";
  }

  /**
   * Return an array of Puppeteer cookies suitable for `page.setCookie(...cookies)`.
   *
   * @returns {Array<Object>}
   * @example
   * const cookies = jar.toPuppeteer();
   * await page.setCookie(...cookies);
   */
  toPuppeteer() {
    return this.toJSON().map(c => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || "/",
      expires: typeof c.expires === "number" ? c.expires : undefined,
      httpOnly: !!c.httpOnly,
      secure: !!c.secure,
      sameSite: c.sameSite
    }));
  }

  /**
   * Return an array compatible with tough-cookie `Cookie.fromJSON(obj)`.
   *
   * @returns {Array<Object>}
   * @example
   * import { Cookie } from "tough-cookie";
   * const arr = jar.toToughJSON();
   * const tc = Cookie.fromJSON(arr[0]);
   */
  toToughJSON() {
    return this.toJSON().map((c, idx) => ({
      key: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || "/",
      secure: !!c.secure,
      httpOnly: !!c.httpOnly,
      hostOnly: !!c.hostOnly,
      pathIsDefault: !c.path || c.path === "/",
      creation: new Date().toISOString(),
      lastAccessed: new Date().toISOString(),
      expires: typeof c.expires === "number" ? new Date(c.expires * 1000).toISOString() : "Infinity",
      sameSite: c.sameSite,
      creationIndex: idx
    }));
  }

  /**
   * Load cookies into an existing `tough-cookie` CookieJar.
   * Requires the `tough-cookie` package at runtime.
   *
   * @param {import("tough-cookie").CookieJar} jar
   * @returns {Promise<void>}
   *
   * @example
   * import { CookieJar } from "tough-cookie";
   * const jar = new CookieJar();
   * await new Cookies("Cookie: a=1").intoCookieJar(jar);
   */
  async intoCookieJar(jar) {
    if (!jar) return;
    const tough = await import("tough-cookie").catch(() => null);
    if (!tough) throw new Error("tough-cookie is not installed");
    const { Cookie } = tough;
    for (const cj of this.toToughJSON()) {
      const cookie = Cookie.fromJSON(cj);
      if (!cookie) continue;
      const domain = cj.domain || "";
      const url = (domain.startsWith("http") ? domain : ("http://" + domain)) + (cj.path || "/");
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve, reject) => {
        jar.setCookie(cookie, url, {}, (err) => err ? reject(err) : resolve(null));
      });
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Internals
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * @private
   * Parse any supported cookie format into {@link NormalCookie[]}.
   *
   * @param {any} input
   * @param {ParseOptions} [options]
   * @returns {NormalCookie[]}
   */
  parseAny(input, options = {}) {
    if (input == null) return [];
    if (Array.isArray(input)) {
      const out = [];
      for (const item of input) out.push(...this.parseAny(item, options));
      return out;
    }
    if (typeof input === "object") {
      if (Array.isArray(input.cookies)) return this.parseAny(input.cookies, options);
      const keys = Object.keys(input);
      if (keys.length && !("name" in input && "value" in input)) {
        // map {name:value}
        return keys.map(k => ({ name: k, value: String(input[k]) }));
      }
      if ("name" in input && "value" in input) {
        return [this.normalizeObjectCookie(input)];
      }
      return [];
    }
    if (typeof input === "string") {
      const s = stripBOM(input.trim());
      if (!s) return [];
      // JSON string?
      if ((s.startsWith("{") && s.endsWith("}")) || (s.startsWith("[") && s.endsWith("]"))) {
        try { return this.parseAny(JSON.parse(s), options); } catch {}
      }
      if (isLikelyNetscape(s)) return parseNetscapeCookiesTxt(s);
      if (/^set-cookie:/im.test(s)) return s.split(/\r?\n/).map(l => parseSetCookie(l)).filter(Boolean);
      if (/^cookie:/i.test(s)) return parseCookieHeader(s.slice(s.indexOf(":") + 1).trim());
      if (s.includes("\n") && /name[,;\t]value/i.test(s.split(/\r?\n/)[0])) return parseCSVorTSV(s);
      if (s.includes("=") && s.includes(";")) return parseCookieHeader(s);
      if (s.includes("=")) {
        const eq = s.indexOf("=");
        const name = s.slice(0, eq).trim();
        const value = s.slice(eq + 1).trim();
        return name ? [{ name, value }] : [];
      }
      return [];
    }
    return [];
  }

  /**
   * @private
   * Normalize a single object-ish cookie record into {@link NormalCookie}.
   * @param {any} obj
   * @returns {NormalCookie}
   */
  normalizeObjectCookie(obj) {
    return {
      name: obj.name ?? obj.key,
      value: obj.value ?? obj.val ?? "",
      domain: obj.domain ?? obj.host,
      path: obj.path ?? "/",
      expires: obj.expires != null
        ? (typeof obj.expires === "number" ? obj.expires : toUnixSeconds(obj.expires))
        : (obj.expiry != null ? (typeof obj.expiry === "number" ? obj.expiry : toUnixSeconds(obj.expiry)) : null),
      httpOnly: !!(obj.httpOnly ?? obj.httponly),
      secure: !!obj.secure,
      sameSite: normSameSite(obj.sameSite ?? obj.samesite),
      hostOnly: obj.hostOnly ?? undefined,
      session: obj.session ?? undefined
    };
  }
}
