// index.js (package entrypoint)
/**
 * @module stealth-api
 *
 * Public entrypoint that re-exports the library's main classes and helpers.
 *
 * ## Quick Start
 *
 * ```js
 * import { Cookie, ApiPoster, Puppeteer, pick2025UA } from "stealth-api";
 *
 * // 1) Cookies (accepts header, Set-Cookie, cookies.txt, CSV/TSV, JSON, maps)
 * const jar = new Cookie('Cookie: a=1; b=2', { url: 'https://example.com' });
 * console.log(jar.headerValue()); // "a=1; b=2"
 *
 * // 2) Raw HTTP / Puppeteer hybrid client
 * const client = new ApiPoster({ url: 'https://example.com' });
 * await client.get();                         // raw HTTP GET
 * await client.goto('https://example.com');   // switch to puppeteer Page.goto
 *
 * // 3) One-line browser + profile
 * const profile = pick2025UA();
 * const p = new Puppeteer({ headless: true });
 * const { browser, page } = await p.launch(profile);
 * await page.goto('https://example.com');
 * await p.close();
 * ```
 *
 * ## Namespaced puppeteer helpers
 * You can also import a subpath with all Puppeteer helpers:
 *
 * ```js
 * import helpers from "stealth-api/puppeteer";
 * // Apply a UA + UA-CH profile to a page:
 * await helpers.applyProfileToPage(page, pick2025UA());
 * ```
 */

// ----------------------------- Re-exports: MySQL Persist -----------------------------
export { default as MySQL } from "./helpers/persist.mjs";

// ----------------------------- Re-exports: Utils -----------------------------
export { default as Utils } from "./helpers/utils.mjs";

// ----------------------------- Re-exports: Cookies -----------------------------
export { default as Cookie } from "./helpers/cookies.mjs";   // alias: singular
export { default as Cookies } from "./helpers/cookies.mjs";  // original class name

// --------------------------- Re-exports: API Client ----------------------------
export {
  ApiPoster,
  makeEndpointClass,
  EndpointManager,
} from "./classes/api-client.mjs";
export { ApiPoster as StealthAPI } from "./classes/api-client.mjs";

// ------------------------------- UA utilities ---------------------------------
export { pick2025UA, buildHeadersForUA } from "./helpers/ua.mjs";

// ------------------------------- Proxy toolkit --------------------------------
export {
  ProxyDirector,
  ProxyCatalogBuilder,
  normalizeDistribution,
  buildProxyDirectorFromJson,
} from "./helpers/proxy-pool.mjs";

// ----------------------------- Puppeteer helpers ------------------------------
import * as _PHelpersCore from "./helpers/puppeteer.mjs";      // UA/profile/shims
import * as _PHelpersExtras from "./puppeteer/helpers.mjs";     // clicks, taps, TTL, etc.

/**
 * All Puppeteer helpers bundled under a single namespace.
 *
 * Includes:
 *  - applyUAOnNetwork, installNavigatorShims, applyProfileToPage, installPageExtensions,
 *    waitForPopupOrTimeout, waitForPopupWithTimeout, clickNewTabLinkResilient
 *  - clickIfVisible, startTapAll, startMultiTap, armPageTTL, safeEvaluate, clickPossiblyNavigates
 *
 * @example
 * import { puppeteerHelpers } from "stealth-api";
 * await puppeteerHelpers.applyProfileToPage(page, pick2025UA());
 */
export const puppeteerHelpers = { ..._PHelpersCore, ..._PHelpersExtras };

// ---------------------------- Puppeteer convenience ----------------------------

/**
 * Lightweight convenience wrapper around `puppeteer` (or `puppeteer-core`),
 * with a built-in profile applicator.
 *
 * This class is **optional** sugar—use {@link ApiPoster} if you want the
 * fluent HTTP+Puppeteer chain. This wrapper is handy when you just need
 * a browser + page with realistic headers and navigator surfaces.
 */
export class Puppeteer {
  /** @type {import('puppeteer').Browser|null} */ #browser = null;
  /** @type {import('puppeteer').Page|null} */ #page = null;
  /** @type {any} */ #pptr = null;
  /** @type {import('puppeteer').PuppeteerLaunchOptions} */ #launch;

  /**
   * @param {import('puppeteer').PuppeteerLaunchOptions} [launchOptions]
   *
   * @example <caption>Headless with default viewport</caption>
   * const p = new Puppeteer({ headless: true });
   * const { browser, page } = await p.launch();
   *
   * @example <caption>Launch and apply a 2025 profile</caption>
   * import { pick2025UA, Puppeteer } from "stealth-api";
   * const profile = pick2025UA();
   * const p = new Puppeteer({ headless: 'new' });
   * const { page } = await p.launch(profile);       // profile applied
   * await page.goto('https://example.com');
   * await p.close();
   *
   * @example <caption>Connect to an existing browser (devtools endp.)</caption>
   * const p = new Puppeteer();
   * await p.connect({ browserWSEndpoint: process.env.WS_URL }, pick2025UA());
   */
  constructor(launchOptions = {}) { this.#launch = launchOptions; }

  async #importPuppeteer() {
    if (this.#pptr) return this.#pptr;
    try {
      const mod = await import("puppeteer-extra");
      this.#pptr = mod.default ?? mod;
    } catch {
      const mod = await import("puppeteer");
      this.#pptr = mod.default ?? mod;
    }
    return this.#pptr;
  }

  /**
   * Launch a browser, create a page, and optionally apply a UA profile.
   * @param {import('./helpers/ua.mjs').UAProfile|null} [profile]
   * @returns {Promise<{ browser: import('puppeteer').Browser, page: import('puppeteer').Page }>}
   *
   * @example <caption>Launch without profile</caption>
   * const { browser, page } = await new Puppeteer({ headless: true }).launch();
   *
   * @example <caption>Launch + profile (network + navigator shims)</caption>
   * const P = new Puppeteer({ headless: true });
   * const { page } = await P.launch(pick2025UA());
   */
  async launch(profile = null) {
    const pptr = await this.#importPuppeteer();
    this.#browser = await pptr.launch(this.#launch);
    this.#page = await this.#browser.newPage();
    if (profile) await _PHelpersCore.applyProfileToPage(this.#page, profile);
    return { browser: this.#browser, page: this.#page };
  }

  /**
   * Connect to an existing browser and open a new page. Optionally apply a profile.
   * @param {import('puppeteer').BrowserConnectOptions} connectOptions
   * @param {import('./helpers/ua.mjs').UAProfile|null} [profile]
   * @returns {Promise<{ browser: import('puppeteer').Browser, page: import('puppeteer').Page }>}
   *
   * @example
   * const p = new Puppeteer();
   * await p.connect({ browserWSEndpoint: ws }, pick2025UA());
   */
  async connect(connectOptions, profile = null) {
    const pptr = await this.#importPuppeteer();
    this.#browser = await pptr.connect(connectOptions);
    this.#page = await this.#browser.newPage();
    if (profile) await _PHelpersCore.applyProfileToPage(this.#page, profile);
    return { browser: this.#browser, page: this.#page };
  }

  /** @returns {import('puppeteer').Browser|null} */
  get browser() { return this.#browser; }
  /** @returns {import('puppeteer').Page|null} */
  get page() { return this.#page; }

  /**
   * Close the page & browser (if open). Safe to call multiple times.
   * @returns {Promise<void>}
   *
   * @example
   * const p = new Puppeteer({ headless: true });
   * await p.launch();
   * // ... work ...
   * await p.close();
   */
  async close() {
    try { await this.#page?.close(); } catch {}
    try { await this.#browser?.close(); } catch {}
    this.#page = null; this.#browser = null;
  }
}
