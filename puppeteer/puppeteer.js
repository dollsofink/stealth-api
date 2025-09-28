// puppeteer.js (subpath facade)
/**
 * @module stealth-api/puppeteer
 *
 * Facade exposing **all** Puppeteer helpers as a single default export.
 *
 * ### Example
 * ```js
 * import helpers from "stealth-api/puppeteer";
 * import { pick2025UA } from "stealth-api";
 *
 * const profile = pick2025UA();
 * await helpers.applyProfileToPage(page, profile);
 * const clicked = await helpers.clickIfVisible(page, '.cta');
 * ```
 */
import * as Core from "../helpers/puppeteer.mjs";     // UA/network + navigator shims
import * as Extra from "./helpers.mjs";    // click/tap/TTL utilities
import * as NetTap from "./nettap.mjs";    // click/tap/TTL utilities

const helpers = { ...Core, ...Extra, ...NetTap };
export default helpers;

export * from "../helpers/puppeteer.mjs";
export * from "./helpers.mjs";
export * from "./nettap.mjs";
