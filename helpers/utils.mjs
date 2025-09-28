import { setTimeout as nodeSleep } from 'node:timers/promises';

/**
 * Pause for a random duration between `min` and `max` milliseconds (inclusive).
 * The order of `min`/`max` doesn’t matter; the function will normalize them.
 *
 * @example <caption>Basic usage</caption>
 * import { randomSleep } from './utils/sleep.js';
 *
 * // Wait somewhere between 1s and 3s
 * await randomSleep(1000, 3000);
 *
 * @example <caption>Puppeteer: human-like delay before clicking</caption>
 * import { randomSleep } from './utils/sleep.js';
 * // ...
 * await page.waitForSelector('#submit');
 * await randomSleep(500, 1500);
 * await page.click('#submit');
 *
 * @param {number} min - Lower bound in milliseconds (inclusive).
 * @param {number} max - Upper bound in milliseconds (inclusive).
 * @returns {Promise<void>} Resolves after the randomized delay.
 */
export function randomSleep(min, max) {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  const ms = Math.floor(Math.random() * (hi - lo + 1)) + lo;
  return nodeSleep(ms);
}

/**
 * A promise-based sleep function (Node’s `timers/promises.setTimeout`) augmented
 * with convenience helpers:
 *
 * - `sleep.random(min, max)` – random delay between bounds (inclusive)
 * - `sleep.jitter(baseMs, plusMinus)` – random delay in `[baseMs-±, baseMs+±]`
 *
 * We attach methods to the function object (which is allowed) rather than
 * re-binding the import (which is read-only). This keeps the familiar `sleep(ms)`
 * usage while adding a simple fluent surface for randomized waits.
 *
 * @example <caption>Basic delays</caption>
 * import { sleep } from './utils/sleep.js';
 *
 * await sleep(750);                 // fixed 750ms delay
 * await sleep.random(1000, 3000);   // 1–3s random delay
 * await sleep.jitter(1500, 400);    // 1100–1900ms random delay
 *
 * @example <caption>Puppeteer: stagger actions with noise</caption>
 * import { sleep } from './utils/sleep.js';
 *
 * await page.goto('https://example.com', { waitUntil: 'domcontentloaded' });
 * await sleep.jitter(1200, 300);    // small human-like pause
 * await page.type('#q', 'puppeteer');
 * await sleep.random(300, 900);
 * await page.click('#search');
 *
 * @type {((ms: number) => Promise<void>) & {
 *   random(min: number, max: number): Promise<void>;
 *   jitter(baseMs: number, plusMinus?: number): Promise<void>;
 * }}
 */
export const sleep = Object.assign(
  /**
   * Pause for `ms` milliseconds.
   * @param {number} ms
   * @returns {Promise<void>}
   */
  function sleep(ms) {
    return nodeSleep(ms);
  },
  {
    /**
     * Pause for a random duration between `min` and `max` milliseconds (inclusive).
     *
     * @param {number} min - Lower bound in ms (inclusive).
     * @param {number} max - Upper bound in ms (inclusive).
     * @returns {Promise<void>}
     */
    random(min, max) {
      return randomSleep(min, max);
    },

    /**
     * Pause with jitter around a base duration, i.e. in the range
     * `[baseMs - plusMinus, baseMs + plusMinus]`. Floors at 0ms.
     *
     * @param {number} baseMs - Center of the window in ms.
     * @param {number} [plusMinus=250] - Half-width of the window in ms.
     * @returns {Promise<void>}
     */
    jitter(baseMs, plusMinus = 250) {
      const lo = Math.max(0, baseMs - plusMinus);
      const hi = baseMs + plusMinus;
      return randomSleep(lo, hi);
    },
  }
);

/**
 * Build a parameterized `INSERT` statement from a plain object.
 *
 * This utility turns a JS object into a safe, positional-parameter SQL insert.
 * It supports:
 *  - Column aliasing: map object keys to different DB column names
 *  - Extra fields: append/override values right before the SQL is built (e.g. flags, timestamps)
 *
 * Values are returned as an array for use with `mysql2` prepared statements.
 * Column identifiers are backtick-escaped. Any `undefined` values in `row` or `extra`
 * are normalized to `null` so MySQL will accept them.
 *
 * @param {string} table
 *   The table name to insert into. (Will be backtick-escaped.)
 *
 * @param {Record<string, any>} row
 *   A plain object where keys are source field names and values are the data to insert.
 *
 * @param {Object} [opts]
 * @param {Record<string, string>} [opts.alias]
 *   Optional mapping from `row` keys to DB column names, e.g. `{ video_url: 'url' }`.
 *   If a key isn’t in `alias`, its original name is used as the column name.
 *
 * @param {Record<string, any>} [opts.extra]
 *   Optional additional fields to merge in (after aliasing), useful for last-second
 *   overrides, flags, or metadata (e.g. `run_id`, `created_at`, etc.).
 *
 * @returns {{ sql: string, values: any[] }}
 *   An object with the parameterized SQL string and a `values` array matching the placeholders.
 *
 * @throws {Error}
 *   If there are no columns to insert (empty `row` and no `extra`).
 *
 * @example
 * // --- Puppeteer usage example ---
 * // Collect data from the page, add/override fields, then insert with mysql2.
 *
 * import mysql from 'mysql2/promise';
 *
 * const connection = await mysql.createConnection({ // your connection params here });
 *
 * // 1) Collect data from the browser context
 * const scraped = await page.evaluate(() => {
 *   return {
 *     video_id: Number(html5player.id_video),
 *     video_url: location.href,
 *     username: html5player.uploader_name,
 *     ua: navigator.userAgent,
 *     // maybe undefined fields will be normalized to NULL
 *     ad_clicked_url: undefined
 *   };
 * });
 *
 * // 2) Build INSERT, mapping JS keys to DB columns and appending extras
 * const { sql, values } = buildInsertQuery('xv_views', scraped, {
 *   alias: {
 *     video_url: 'url',  // JS: video_url  -> DB: url
 *     ua: 'user_agent'   // JS: ua         -> DB: user_agent
 *   },
 *   extra: {
 *     ad_clicked: 1,
 *     watch_started_at: new Date().toISOString().replace('T', ' '),
 *   }
 * });
 *
 * // 3) Execute safely with prepared statement
 * // Example final SQL: INSERT INTO `xv_views` (`video_id`,`url`,`username`,`user_agent`,`ad_clicked`,`watch_started_at`,`ad_clicked_url`) VALUES (?,?,?,?,?,?,?)
 * await connection.execute(sql, values);
 */
export function buildInsertQuery(table, row, opts = {}) {
  const { alias = {}, extra = {} } = opts;

  // 1) apply key aliases (e.g. { video_url: 'url' }) then merge extras
  const base = Object.entries(row).reduce((acc, [k, v]) => {
    const col = alias[k] || k;
    acc[col] = v;
    return acc;
  }, {});
  const obj = { ...base, ...extra };

  const cols = Object.keys(obj);
  if (cols.length === 0) throw new Error('No columns to insert');

  // 2) minimal identifier escape using backticks
  const qid = (id) => `\`${String(id).replace(/`/g, '``')}\``;

  // 3) placeholders and values in the same order
  const placeholders = cols.map(() => '?').join(', ');
  const values = cols.map((k) => (obj[k] === undefined ? null : obj[k]));

  const sql = `INSERT INTO ${qid(table)} (${cols.map(qid).join(', ')}) VALUES (${placeholders})`;
  return { sql, values };
}

/**
 * @typedef {Object} RandomFluent
 * @property {(a:number, b:number) => RandomFluent} between
 *  Set the numeric range (order-agnostic).
 * @property {() => RandomFluent} inclusive
 *  Make the range inclusive on both ends (default).
 * @property {() => RandomFluent} exclusive
 *  Make the range exclusive on both ends (nudges floats, shrinks int span).
 * @property {() => number} int
 *  Return a random integer in the configured range.
 * @property {() => number} float
 *  Return a random float in the configured range.
 * @property {(dp?:number) => number} fixed
 *  Return a random float rounded to `dp` decimal places (default 2).
 * @property {<T>(arr:T[]) => T} pick
 *  Pick a random element from a non-empty array.
 */

/**
 * Safely installs a non-enumerable `Array.prototype.random()` method if it
 * isn’t already present. The method returns a random element from the array or
 * `undefined` for an empty array.
 *
 * - Non-enumerable: won’t appear in `for…in`, `Object.keys`, or JSON.
 * - Guarded: won’t overwrite an existing implementation.
 * - Global effect: extends the Array prototype in the current Node process.
 *
 * @example <caption>Option A — Side-effect import (auto-installs on import)</caption>
 * // main.mjs
 * import './utils/random.js';              // auto-installs Array.prototype.random
 * import { random } from './utils/random.js';
 *
 * console.log([1, 2, 3, 4].random());     // e.g. 3
 * console.log(random().between(10, 20).int()); // e.g. 14
 *
 * @example <caption>Option B — Explicit install (no side-effects on import)</caption>
 * // main.mjs
 * import { installArrayRandom, random } from './utils/random.js';
 *
 * installArrayRandom();                    // attach when you want
 * console.log(['a', 'b', 'c'].random());  // e.g. "b"
 * console.log(random().between(0, 1).fixed(3)); // e.g. 0.732
 *
 * @returns {void}
 */
export function installArrayRandom() {
  if (!Object.prototype.hasOwnProperty.call(Array.prototype, 'random')) {
    /**
     * Return a random element from the array.
     * Returns `undefined` if the array is empty.
     *
     * @function Array#random
     * @this {Array<*>}
     * @returns {*|undefined}
     *
     * @example
     * ['x','y','z'].random(); // → 'y' (random)
     * [].random();            // → undefined
     */
    Object.defineProperty(Array.prototype, 'random', {
      value: function () {
        if (this == null) throw new TypeError('Array.prototype.random called on null/undefined');
        const len = this.length >>> 0; // to uint32
        if (len === 0) return undefined;
        const idx = Math.floor(Math.random() * len);
        return this[idx];
      },
      writable: false,
      configurable: true,
      enumerable: false, // keeps it out of enumeration / JSON
    });
  }
}

/**
 * Fluent random-number helper.
 *
 * Create a builder via `random()` then configure it with:
 * - `.between(min, max)` to set range (order-agnostic)
 * - `.inclusive()` (default) or `.exclusive()` to control endpoint behavior
 *
 * Then generate a value with `.int()`, `.float()`, or `.fixed(dp)`.
 * You can also use `.pick(arr)` to select a random array element.
 *
 * @example
 * import { random } from './utils/random.js';
 *
 * // Integer in [10, 20]
 * const n = random().between(10, 20).inclusive().int();
 *
 * // Float in (0, 1) exclusive, with 3 decimals
 * const f = random().between(0, 1).exclusive().fixed(3);
 *
 * // Pick an element from an array
 * const color = random().pick(['red', 'green', 'blue']);
 *
 * @returns {RandomFluent}
 */
export const random = () => {
  let min = 0, max = 1, inclusive = true;

  /** @type {RandomFluent} */
  const api = {
    between(a, b) { min = Math.min(a, b); max = Math.max(a, b); return api; },
    inclusive() { inclusive = true; return api; },
    exclusive() { inclusive = false; return api; },

    int() {
      const lo = Math.ceil(min);
      const hi = Math.floor(max);
      const span = inclusive ? (hi - lo + 1) : (hi - lo);
      if (span <= 0) throw new Error('No integers available in the given range');
      return Math.floor(Math.random() * span) + lo;
    },

    float() {
      const r = Math.random();
      let val = min + r * (max - min); // [min, max)
      if (!inclusive) {
        // nudge away from endpoints for exclusivity
        const eps = Number.EPSILON;
        val = Math.min(max - eps, Math.max(min + eps, val));
      }
      return val;
    },

    fixed(dp = 2) {
      return Number(api.float().toFixed(dp));
    },

    pick(arr) {
      if (!Array.isArray(arr) || arr.length === 0) {
        throw new Error('Non-empty array required');
      }
      return arr[Math.floor(Math.random() * arr.length)];
    }
  };

  return api;
};

// --- Auto-install on import (side effect).
// Comment this out if you prefer explicit install in your entry file.
installArrayRandom();

/**
 * Blend two arrays into a target ratio. If one side lacks enough elements,
 * randomly clone from that side (sample with replacement) to satisfy the ratio.
 *
 * @param {Array} a                    First array
 * @param {Array} b                    Second array
 * @param {number|string} ratio        Share for `a`:
 *                                     - number in (0,1] → e.g. 0.6 for 60%
 *                                     - number in (1,100] → e.g. 60 for 60%
 *                                     - string "60:40" or "50:50" → a:b parts
 *                                     - string "60%" → percent for `a`
 * @param {Object} [opts]
 * @param {number} [opts.totalLength]  Final size. Defaults to a.length + b.length
 * @param {boolean} [opts.interleave]  If true, interleave by remaining proportion.
 *                                     If false, shuffle the final collection at the end.
 * @returns {Array} blended array
 *
 * @example
 * // 50:50 blend of 2 numbers and 10 letters → result length 12 with 6 from each side (numbers cloned)
 * const out = blendArrays([1,2], ['a','b','c','d','e','f','g','h','i','j'], "50:50");
 *
 * @example
 * // 60:40 with explicit total length 20 → 12 from A, 8 from B
 * const out = blendArrays(["A","B","C"], [1,2,3,4,5,6,7,8,9], 0.6, { totalLength: 20 });
 *
 * @example
 * // 70% A using "70%" and a flat shuffle (no interleave)
 * const out = blendArrays(["x","y"], ["o","p","q","r","s"], "70%", { interleave: false });
 */
export function blendArrays(a, b, ratio, opts = {}) {
  const { totalLength = (a?.length || 0) + (b?.length || 0), interleave = true } = opts;

  if (!Array.isArray(a) || !Array.isArray(b)) {
    throw new TypeError("blendArrays: both inputs must be arrays");
  }
  if (!Number.isFinite(totalLength) || totalLength < 0) {
    throw new RangeError("blendArrays: totalLength must be a non-negative number");
  }

  const shareA = normalizeRatio(ratio); // 0..1
  const needA = Math.round(totalLength * shareA);
  const needB = totalLength - needA;

  if (needA > 0 && a.length === 0) {
    throw new Error("blendArrays: cannot satisfy ratio — array A is empty but needA > 0");
  }
  if (needB > 0 && b.length === 0) {
    throw new Error("blendArrays: cannot satisfy ratio — array B is empty but needB > 0");
  }

  // Pick items from each side (without replacement until exhausted, then with replacement)
  const pickedA = pickNWithCloning(a, needA);
  const pickedB = pickNWithCloning(b, needB);

  if (!interleave) {
    // Simple path: just combine and shuffle
    return shuffle([...pickedA, ...pickedB]);
  }

  // Interleave according to remaining proportions (keeps mix visually balanced)
  const out = [];
  let iA = 0, iB = 0;
  let remA = pickedA.length, remB = pickedB.length;

  while (remA + remB > 0) {
    const pA = remA / (remA + remB);
    const chooseA = Math.random() < pA;
    if (chooseA && remA > 0) {
      out.push(pickedA[iA++]); remA--;
    } else if (remB > 0) {
      out.push(pickedB[iB++]); remB--;
    } else {
      // one side exhausted (shouldn't happen because pA uses remaining),
      // but just in case, drain the other.
      while (remA-- > 0) out.push(pickedA[iA++]);
      while (remB-- > 0) out.push(pickedB[iB++]);
    }
  }
  return out;
}

/* -------------------------- helpers (internal) -------------------------- */

// Parse ratio into a fraction for A in [0,1].
function normalizeRatio(r) {
  if (r == null) return 0.5;
  if (typeof r === "number") {
    if (r > 1 && r <= 100) return r / 100;
    if (r > 0 && r <= 1) return r;
  }
  if (typeof r === "string") {
    const s = r.trim();
    const pct = s.match(/^(\d+(?:\.\d+)?)\s*%$/);
    if (pct) return clamp(parseFloat(pct[1]) / 100, 0, 1);
    const parts = s.split(":").map(x => x.trim());
    if (parts.length === 2 && parts.every(p => /^\d+(\.\d+)?$/.test(p))) {
      const a = parseFloat(parts[0]);
      const b = parseFloat(parts[1]);
      const sum = a + b;
      if (sum > 0) return a / sum;
    }
  }
  throw new Error(`blendArrays: invalid ratio "${r}" (use 0.6, 60, "60%", "60:40", etc.)`);
}

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

// Pick n items from arr. If n <= arr.length → sample w/o replacement.
// If n > arr.length → take all (shuffled) then fill the rest by sampling with replacement.
function pickNWithCloning(arr, n) {
  if (n <= 0) return [];
  if (arr.length === 0) throw new Error("pickNWithCloning: cannot pick from empty array");

  if (n <= arr.length) {
    return shuffle(arr.slice()).slice(0, n);
  }
  const out = shuffle(arr.slice()); // take all once
  // fill remainder with replacement
  for (let i = arr.length; i < n; i++) {
    const idx = Math.floor(Math.random() * arr.length);
    out.push(arr[idx]);
  }
  return out;
}

// Fisher–Yates
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Convert many human formats into a probability in [0, 1].
 *
 * Accepted inputs:
 *  - Number:
 *      0.2        → 0.2
 *      20         → 0.2   (assumed percent if 1 < n ≤ 100)
 *  - String:
 *      "0.2"      → 0.2
 *      "20%"      → 0.2
 *      "3/4"      → 0.75
 *      "3:1"      → 0.75   (odds success:failure ⇒ s/(s+f))
 *      "3 to 1"   → 0.75   (same as above)
 *      "1 in 4"   → 0.25   (also: "x of y", "x out of y")
 *  - Object:
 *      { p: 0.2 }
 *      { numerator: 3, denominator: 4 }
 *      { success: 3, failure: 1 }
 *
 * Throws on invalid/ambiguous values (negatives, div-by-zero, >100% etc.).
 *
 * @param {number|string|{
 *   p?: number,
 *   numerator?: number, denominator?: number,
 *   success?: number, failure?: number
 * }} input
 * @returns {number} Probability in [0, 1]
 */
export function toProbability(input) {
  const fail = (msg) => {
    throw new TypeError(`toProbability: ${msg}`);
  };

  const asNum = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) fail(`not a finite number: ${v}`);
    return n;
  };

  const asNonNegative = (n, label) => {
    if (n < 0) fail(`${label} must be ≥ 0`);
    return n;
  };

  const frac = (num, den) => {
    num = asNum(num);
    den = asNum(den);
    asNonNegative(num, 'numerator');
    asNonNegative(den, 'denominator');
    if (den === 0) fail('denominator must be > 0');
    const p = num / den;
    if (p < 0 || p > 1) fail(`fraction ${num}/${den} not in [0,1]`);
    return p;
  };

  // Numbers
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) fail('input number is not finite');
    if (input < 0) fail('number must be ≥ 0');

    if (input <= 1) return input;     // assume decimal prob
    if (input <= 100) return input / 100; // assume percent
    fail('number > 100 is invalid (percent must be ≤ 100)');
  }

  // Objects
  if (typeof input === 'object' && input !== null) {
    const { p, numerator, denominator, success, failure } = input;

    if (typeof p === 'number') {
      return toProbability(p);
    }
    if (typeof numerator === 'number' && typeof denominator === 'number') {
      return frac(numerator, denominator);
    }
    if (typeof success === 'number' && typeof failure === 'number') {
      const s = asNonNegative(asNum(success), 'success');
      const f = asNonNegative(asNum(failure), 'failure');
      const total = s + f;
      if (total === 0) fail('success+failure must be > 0');
      return s / total;
    }
    fail('unsupported object shape');
  }

  // Strings
  if (typeof input === 'string') {
    const s = input.trim().toLowerCase().replace(/\s+/g, ' ');

    // percent
    if (/%$/.test(s)) {
      const n = asNum(s.slice(0, -1));
      if (n < 0 || n > 100) fail('percent must be in [0,100]');
      return n / 100;
    }

    // "x in y", "x of y", "x out of y"
    {
      const m = s.match(/^(\d+(?:\.\d+)?)\s+(?:in|of|out of)\s+(\d+(?:\.\d+)?)$/);
      if (m) return frac(m[1], m[2]);
    }

    // "a to b" (odds success:failure)
    {
      const m = s.match(/^(\d+(?:\.\d+)?)\s+to\s+(\d+(?:\.\d+)?)$/);
      if (m) {
        const a = asNonNegative(asNum(m[1]), 'success');
        const b = asNonNegative(asNum(m[2]), 'failure');
        const total = a + b;
        if (total === 0) fail('odds total must be > 0');
        return a / total;
      }
    }

    // "a:b" (odds success:failure)
    if (s.includes(':')) {
      const [a, b] = s.split(':');
      const sa = asNonNegative(asNum(a), 'success');
      const sb = asNonNegative(asNum(b), 'failure');
      const total = sa + sb;
      if (total === 0) fail('odds total must be > 0');
      return sa / total;
    }

    // "a/b" (fraction)
    if (s.includes('/')) {
      const [a, b] = s.split('/');
      return frac(a, b);
    }

    // decimal-ish number in a string
    {
      const n = Number(s);
      if (Number.isFinite(n)) return toProbability(n);
    }

    fail(`unrecognized string format: "${input}"`);
  }

  fail(`unsupported input type: ${typeof input}`);
}

/**
 * Return true with the given likelihood.
 *
 * @param {Parameters<typeof toProbability>[0]} probInput
 *   Any format supported by toProbability().
 * @param {Object} [opts]
 * @param {() => number} [opts.rand=Math.random]
 *   RNG returning a uniform number in [0,1). Inject for determinism in tests.
 * @returns {boolean}
 *
 * @example
 * chance('75%')        // ~75% true
 * chance(0.2)          // 20% true
 * chance('3/4')        // 75% true
 * chance('3:1')        // 75% true (3 to 1 odds)
 * chance('1 in 6')     // ≈16.7% true
 * chance({ success:3, failure:1 }) // 75% true
 */
export function chance(probInput, { rand = Math.random } = {}) {
  const p = toProbability(probInput);
  // guard: floating point quirks
  if (p < 0 || p > 1) {
    throw new RangeError(`chance: probability ${p} not in [0,1]`);
  }
  return rand() < p;
}

/* ------------------------------ Examples ------------------------------ */

// console.log(toProbability('75%'));         // 0.75
// console.log(toProbability(75));            // 0.75
// console.log(toProbability(0.75));          // 0.75
// console.log(toProbability('3/4'));         // 0.75
// console.log(toProbability('3:1'));         // 0.75
// console.log(toProbability('3 to 1'));      // 0.75
// console.log(toProbability('1 in 4'));      // 0.25
// console.log(toProbability({ p: 0.42 }));   // 0.42
// console.log(toProbability({ numerator:1, denominator:6 })); // 0.1666…
// console.log(toProbability({ success:3, failure:1 }));       // 0.75
// console.log(chance('20%'));                // true/false

/**
 * Weighted pick.
 * @template T
 * @param {{key?: T, w: number}[]} list
 * @returns {T}
 */
export function pickWeighted(list) {
  const total = list.reduce((s, x) => s + x.w, 0);
  let r = Math.random() * total;
  for (const x of list) {
    r -= x.w;
    if (r <= 0) return x.key ?? x;
  }
  return list.at(-1).key ?? list.at(-1);
}

/**
 * Array rand
 * @template T
 * @param {T[]} arr
 * @returns {T}
 */
export const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];

// Aggregating all exports into a single Utils object.
const Utils = {
    randomSleep,
    sleep,
    buildInsertQuery,
    random,
    toProbability,
    chance,
};

// Exporting the Utils object as the default export.
export default Utils;