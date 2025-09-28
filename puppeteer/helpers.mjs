import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { sleep } from '../utils.mjs';

/**
 * Try to click an element **only if** it currently exists and is actually visible on screen.
 *
 * This helper:
 * 1) Queries the element with `page.$(selector)`.
 * 2) Verifies basic visibility heuristics in the page context (non-zero size, not `display:none`,
 *    not `visibility:hidden`, not `opacity:0`, and at least partially within the viewport).
 * 3) Scrolls it into view and attempts a real Puppeteer click with a small human-like delay.
 * 4) If the native click fails (e.g., minor overlay), falls back to a DOM `element.click()` in the page.
 *
 * It is a single-shot check: it **does not wait** for the element to appear. If you need to wait,
 * pair it with `page.waitForSelector(selector)` (optionally with a timeout) before calling this.
 *
 * Notes:
 * - If the target element lives inside an `<iframe>`, you must resolve that frame and call this
 *   function with the frame's `pageLike` (i.e., the `Frame` object) and a selector **relative to that frame**.
 * - The visibility heuristic is intentionally lightweight; highly dynamic overlays may still block clicks.
 *
 * @param {import('puppeteer').Page | import('puppeteer').Frame} page
 *        A Puppeteer `Page` (or `Frame`) to operate against.
 * @param {string} selector
 *        Any valid DOM selector that uniquely identifies the element to click.
 * @returns {Promise<boolean>}
 *          Resolves `true` if a click was attempted successfully (native or DOM).
 *          Resolves `false` if the element was not found or not visible at the time of the call.
 *
 * @example
 * // Basic usage with Puppeteer:
 * import puppeteer from 'puppeteer';
 *
 * (async () => {
 *   const browser = await puppeteer.launch({ headless: false });
 *   const page = await browser.newPage();
 *   await page.goto('https://example.com', { waitUntil: 'domcontentloaded' });
 *
 *   // Optional: wait for the element to show up (won't throw if it times out)
 *   await page.waitForSelector('.disclaimer-enter', { timeout: 3000 }).catch(() => {});
 *
 *   const clicked = await clickIfVisible(page, '.disclaimer-enter');
 *   console.log('Clicked disclaimer?', clicked);
 *
 *   await browser.close();
 * })();
 *
 * @example
 * // Inside an iframe:
 * const frame = page.frames().find(f => /iframe-domain\.com/.test(f.url()));
 * if (frame) {
 *   const ok = await clickIfVisible(frame, 'button.accept');
 *   console.log('Clicked inside frame?', ok);
 * }
 */
export async function clickIfVisible(page, selector) {
  const handle = await page.$(selector);
  if (!handle) return false;

  const visible = await handle.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    const hasSize = rect.width > 0 && rect.height > 0;
    const displayed = style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    const onScreen =
      rect.bottom >= 0 &&
      rect.right >= 0 &&
      rect.top < window.innerHeight &&
      rect.left < window.innerWidth;
    return hasSize && displayed && onScreen;
  });

  if (!visible) { await handle.dispose(); return false; }

  // Bring it into view and try a real click
  await handle.evaluate(el => { try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch { } });

  try {
    await handle.click({ delay: Math.floor(Math.random() * 120) });
    await handle.dispose();
    return true;
  } catch {
    // Fallback: DOM click (works even if something overlays slightly)
    await page.evaluate(sel => document.querySelector(sel)?.click(), selector);
    await handle.dispose();
    return true;
  }
}

/**
 * Start tapping ALL requests/responses that match `urlRegex`.
 * No interception needed unless you want to modify traffic.
 *
 * Returns a controller with:
 *  - records: live array of {ts, kind, url, method, status, requestBody, responseBody}
 *  - stop(): detach listeners and return the final records
 *  - waitForQuiet(quietMs=1500, maxMs=15000): resolve when no new events for `quietMs` (or at `maxMs`)
 * 
 * CDP-based tap for ALL requests that match `urlRegex`, with JSON request-body parsing.
 *
 * Output shape for each record:
 * {
 *   ts,
 *   request: {
 *     ts, url, method, headers,
 *     postDataRaw,                // string | null
 *     bodyJson,                   // object | array | null    (parsed JSON)
 *     bodyForm,                   // { [key]: value } | null  (parsed x-www-form-urlencoded)
 *     type, timestamp
 *   },
 *   response: {
 *     ts, url, status, statusText, mimeType,
 *     headers,                    // normalized
 *     body,                       // JSON | text | base64 string (if binary)
 *     base64Encoded
 *   }
 * }
 * 
    // three independent taps
    const [tapApi, tapVreg, tapClick] = await Promise.all([
    startTapAll(page, /https:\/\/s\.orbsrv\.com\/v1\/api\.php/),
    startTapAll(page, /https:\/\/s\.orbsrv\.com\/vregister\.php/),
    startTapAll(page, /https:\/\/s\.orbsrv\.com\/click\.php/),
    ]);

    try {
    // fire whatever causes those requests (e.g. VAST)
    await page.evaluate(() => html5player.checkVideoAds());

    // wait until the network quiets down for all three taps
    await Promise.all([
        tapApi.waitForQuiet(2000, 15000),
        tapVreg.waitForQuiet(2000, 15000),
        tapClick.waitForQuiet(2000, 15000),
    ]);

    // collect & detach
    const [apiRecords, vregRecords, clickRecords] = await Promise.all([
        tapApi.stop(),
        tapVreg.stop(),
        tapClick.stop(),
    ]);

    // use them
    console.log('api.php hits:', apiRecords.length);
    console.log('vregister.php hits:', vregRecords.length);
    console.log('click.php hits:', clickRecords.length);

    } finally {
    // if you may exit early, still detach
    try { await tapApi?.stop(); } catch {}
    try { await tapVreg?.stop(); } catch {}
    try { await tapClick?.stop(); } catch {}
    }
 * 
 */
export async function startTapAll(page, urlRegex, {
  includeBodies = true,
  parseJson = true,           // parse response JSON
  includeRequestBodies = true,
  requestBodyMaxLen = 512 * 1024, // soft cap to avoid giant payloads
} = {}) {
  const client = await page.createCDPSession();
  await client.send('Network.enable', {});

  const inflight = new Map();
  const records = [];
  let lastHitAt = Date.now();
  const nowISO = () => new Date().toISOString();

  const normalizeHeaders = (h = {}) => {
    const out = {};
    for (const [k, v] of Object.entries(h)) out[String(k).toLowerCase()] = v;
    return out;
  };

  const looksLikeJson = (s) => {
    if (typeof s !== 'string') return false;
    const t = s.trim();
    return (t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'));
  };

  const parseRequestBody = (entry) => {
    if (!includeRequestBodies) return;
    const raw = entry.request.postDataRaw;
    if (!raw || typeof raw !== 'string') return;

    const headers = entry.request.headers || {};
    const ct = headers['content-type'] || headers['contenttype'] || '';
    const isJsonCT = /application\/json/i.test(ct);

    // Hard cap to avoid massive blobs burning RAM
    const clipped = raw.length > requestBodyMaxLen ? raw.slice(0, requestBodyMaxLen) : raw;

    // Try JSON when declared, or when the text "looks" like JSON
    if (isJsonCT || looksLikeJson(clipped)) {
      try {
        entry.request.bodyJson = JSON.parse(clipped);
        return;
      } catch {
        // fall through
      }
    }

    // Try x-www-form-urlencoded
    if (/application\/x-www-form-urlencoded/i.test(ct)) {
      try {
        const form = {};
        for (const [k, v] of new URLSearchParams(clipped)) {
          // Store first value if repeated keys, or upgrade to array
          if (k in form) {
            form[k] = Array.isArray(form[k]) ? [...form[k], v] : [form[k], v];
          } else {
            form[k] = v;
          }
        }
        entry.request.bodyForm = form;
        return;
      } catch {
        // ignore
      }
    }

    // Otherwise we leave only the raw string
  };

  client.on('Network.requestWillBeSent', (e) => {
    const { requestId, request, type, timestamp } = e;
    if (!urlRegex.test(request.url)) return;
    lastHitAt = Date.now();

    inflight.set(requestId, {
      request: {
        ts: nowISO(),
        url: request.url,
        method: request.method,
        headers: normalizeHeaders(request.headers),
        postDataRaw: request.postData ?? null,
        bodyJson: null,
        bodyForm: null,
        type,
        timestamp,
      },
      responseMeta: null,
      responseHeaders: null,
    });

    // Early parse (may be refined when ExtraInfo updates headers)
    parseRequestBody(inflight.get(requestId));
  });

  client.on('Network.requestWillBeSentExtraInfo', (e) => {
    const entry = inflight.get(e.requestId);
    if (!entry) return;
    entry.request.headers = normalizeHeaders(e.headers || entry.request.headers);
    // Re-parse now that we have authoritative headers
    parseRequestBody(entry);
  });

  client.on('Network.responseReceived', (e) => {
    const { requestId, response } = e;
    if (!urlRegex.test(response.url)) return;
    lastHitAt = Date.now();

    const entry = inflight.get(requestId) || {
      request: {
        ts: nowISO(),
        url: response.url,
        method: null,
        headers: {},
        postDataRaw: null,
        bodyJson: null,
        bodyForm: null,
        type: e.type,
        timestamp: e.timestamp,
      },
      responseMeta: null,
      responseHeaders: null,
    };
    inflight.set(requestId, entry);

    entry.responseMeta = {
      ts: nowISO(),
      url: response.url,
      status: response.status,
      statusText: response.statusText,
      mimeType: response.mimeType,
      remoteIPAddress: response.remoteIPAddress ?? null,
      remotePort: response.remotePort ?? null,
    };
    entry.responseHeaders = normalizeHeaders(response.headers || entry.responseHeaders);
  });

  client.on('Network.responseReceivedExtraInfo', (e) => {
    const entry = inflight.get(e.requestId);
    if (!entry) return;
    entry.responseHeaders = normalizeHeaders(e.headers || entry.responseHeaders);
  });

  client.on('Network.loadingFinished', async (e) => {
    const entry = inflight.get(e.requestId);
    if (!entry) return;
    lastHitAt = Date.now();

    let body = null;
    let base64Encoded = false;

    if (includeBodies) {
      try {
        const { body: raw, base64Encoded: is64 } =
          await client.send('Network.getResponseBody', { requestId: e.requestId });
        base64Encoded = !!is64;

        const ct = entry.responseHeaders?.['content-type'] || '';
        const textual = !base64Encoded && /^(application\/(json|javascript)|text\/|application\/x-www-form-urlencoded)/i.test(ct);

        if (textual && parseJson) {
          try { body = JSON.parse(raw); } catch { body = raw; }
        } else {
          body = raw;
        }
      } catch {
        body = null;
      }
    }

    records.push({
      ts: nowISO(),
      request: entry.request,
      response: {
        ...entry.responseMeta,
        headers: entry.responseHeaders,
        body,
        base64Encoded,
      },
    });

    inflight.delete(e.requestId);
  });

  client.on('Network.loadingFailed', (e) => {
    const entry = inflight.get(e.requestId);
    if (!entry) return;

    records.push({
      ts: nowISO(),
      request: entry.request,
      response: {
        ...entry.responseMeta,
        headers: entry.responseHeaders,
        status: null,
        statusText: null,
        errorText: e.errorText || 'loadingFailed',
        body: null,
        base64Encoded: false,
      },
    });

    inflight.delete(e.requestId);
  });

  const waitForQuiet = (quietMs = 1500, maxMs = 15000) =>
    new Promise((resolve) => {
      const start = Date.now();
      const timer = setInterval(() => {
        const idle = Date.now() - lastHitAt >= quietMs;
        const timeout = Date.now() - start >= maxMs;
        if (idle || timeout) {
          clearInterval(timer);
          resolve(records);
        }
      }, Math.min(quietMs, 500));
    });

  const stop = async () => {
    client.removeAllListeners();
    try { await client.send('Network.disable'); } catch { }
    try { await client.detach?.(); } catch { }
    return records;
  };

  return { records, waitForQuiet, stop };
}

/**
 * One CDP session; many regex "channels".
 * patterns: { nameA: /.../, nameB: /.../, ... }
 * Returns { recordSets, waitForQuiet, stop }
 * 
    const multi = await startMultiTap(page, {
    api: /https:\/\/s\.orbsrv\.com\/v1\/api\.php/,
    vreg: /https:\/\/s\.orbsrv\.com\/vregister\.php/,
    click: /https:\/\/s\.orbsrv\.com\/click\.php/,
    });

    // trigger the traffic
    await page.evaluate(() => html5player.checkVideoAds());

    // wait/collect
    await multi.waitForQuiet(2000, 15000);
    const { api, vreg, click } = await multi.stop().then(rs => ({
    api: rs.api, vreg: rs.vreg, click: rs.click
    }));

    console.log('api:', api.length, 'vregister:', vreg.length, 'click:', click.length);
 * 
 */
export async function startMultiTap(page, patterns, opts = {}) {
  const client = await page.createCDPSession();
  await client.send('Network.enable', {});
  const names = Object.keys(patterns);
  const matchers = names.map(n => ({ name: n, re: patterns[n] }));

  const inflight = new Map(); // requestId -> entry
  const recordSets = Object.fromEntries(names.map(n => [n, []]));
  let lastHitAt = Date.now();
  const nowISO = () => new Date().toISOString();

  const norm = (h = {}) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));

  client.on('Network.requestWillBeSent', e => {
    const url = e.request?.url || '';
    if (!matchers.some(m => m.re.test(url))) return;
    lastHitAt = Date.now();
    inflight.set(e.requestId, {
      url, type: e.type, timestamp: e.timestamp,
      req: { method: e.request.method, headers: norm(e.request.headers), postData: e.request.postData ?? null },
      res: { headers: {}, meta: null }
    });
  });

  client.on('Network.requestWillBeSentExtraInfo', e => {
    const x = inflight.get(e.requestId);
    if (!x) return;
    x.req.headers = norm(e.headers || x.req.headers);
  });

  client.on('Network.responseReceived', e => {
    const url = e.response?.url || '';
    if (!matchers.some(m => m.re.test(url))) return;
    lastHitAt = Date.now();
    const x = inflight.get(e.requestId) || { url, type: e.type, timestamp: e.timestamp, req: {}, res: { headers: {} } };
    x.res.meta = {
      url,
      status: e.response.status,
      statusText: e.response.statusText,
      mimeType: e.response.mimeType,
    };
    inflight.set(e.requestId, x);
  });

  client.on('Network.responseReceivedExtraInfo', e => {
    const x = inflight.get(e.requestId);
    if (!x) return;
    x.res.headers = norm(e.headers || x.res.headers);
  });

  client.on('Network.loadingFinished', async e => {
    const x = inflight.get(e.requestId);
    if (!x) return;
    lastHitAt = Date.now();

    let body = null, base64Encoded = false;
    try {
      const b = await client.send('Network.getResponseBody', { requestId: e.requestId });
      base64Encoded = !!b.base64Encoded;
      const ct = x.res.headers['content-type'] || '';
      const textual = !base64Encoded && /^(application\/(json|javascript)|text\/|application\/x-www-form-urlencoded)/i.test(ct);
      body = textual ? (tryParseJSON(b.body) ?? b.body) : b.body;
    } catch { }

    const rec = {
      ts: nowISO(),
      request: {
        url: x.url,
        method: x.req.method || null,
        headers: x.req.headers || {},
        postDataRaw: x.req.postData ?? null,
      },
      response: {
        ...x.res.meta,
        headers: x.res.headers,
        body,
        base64Encoded,
      }
    };

    // route to all matching buckets (in case of overlap)
    for (const { name, re } of matchers) {
      if (re.test(x.url)) recordSets[name].push(rec);
    }
    inflight.delete(e.requestId);
  });

  client.on('Network.loadingFailed', e => {
    const x = inflight.get(e.requestId);
    if (!x) return;
    const rec = {
      ts: nowISO(),
      request: {
        url: x.url,
        method: x.req.method || null,
        headers: x.req.headers || {},
        postDataRaw: x.req.postData ?? null,
      },
      response: {
        ...(x.res.meta || { url: x.url }),
        headers: x.res.headers || {},
        status: null,
        statusText: null,
        errorText: e.errorText || 'loadingFailed',
        body: null,
        base64Encoded: false,
      }
    };
    for (const { name, re } of matchers) {
      if (re.test(x.url)) recordSets[name].push(rec);
    }
    inflight.delete(e.requestId);
  });

  const waitForQuiet = (quietMs = 1500, maxMs = 15000) =>
    new Promise(resolve => {
      const start = Date.now();
      const iv = setInterval(() => {
        const idle = Date.now() - lastHitAt >= quietMs;
        const timeout = Date.now() - start >= maxMs;
        if (idle || timeout) { clearInterval(iv); resolve(recordSets); }
      }, Math.min(quietMs, 500));
    });

  const stop = async () => {
    client.removeAllListeners();
    try { await client.send('Network.disable'); } catch { }
    try { await client.detach?.(); } catch { }
    return recordSets;
  };

  function tryParseJSON(s) { try { return JSON.parse(s); } catch { return null; } }

  return { recordSets, waitForQuiet, stop };
}

/**
 * Arm a "time-to-live" (TTL) auto-closer for a Puppeteer page and its popups.
 *
 * This utility attaches timers and listeners to a {@link import('puppeteer').Page}
 * so that:
 *  - After `ttlMs`, the page will be closed automatically.
 *  - Any popups spawned from the page are optionally auto-closed and can be
 *    included in the TTL cleanup.
 *  - (Optional) The TTL can be *extended on activity* (navigation or network
 *    request) when `resetOnActivity` is enabled—useful for implementing
 *    “N seconds of inactivity” semantics instead of a hard deadline.
 *
 * It returns a **cleanup function** that removes listeners/timers early (and
 * does **not** close the page). Call this if you want to disarm the TTL
 * manually before the timer elapses.
 *
 * ### Why/when to use
 * - Prevents runaway tabs (leaked pages that never close).
 * - Keeps “popup storms” in check by auto-closing child windows.
 * - Useful for workers that must guarantee per-task time budgets.
 *
 * @param {import('puppeteer').Page} page
 *   The Puppeteer page to arm with a TTL.
 *
 * @param {Object} [options]
 * @param {number}  [options.ttlMs=60000]
 *   Hard timeout in milliseconds after which the page is closed.
 *
 * @param {boolean} [options.closePopups=true]
 *   If `true`, popups are auto-closed shortly after they open.
 *
 * @param {number}  [options.closePopupsDelayMs=1500]
 *   Delay before auto-closing a popup (gives stealth/evasions time to run,
 *   or lets anti-bot scripts settle before the window disappears).
 *
 * @param {boolean} [options.includePopupsInTTL=true]
 *   If `true`, popups are also closed when the TTL expires.
 *
 * @param {boolean} [options.resetOnActivity=false]
 *   If `true`, any navigation or network request on the page resets the TTL
 *   (i.e., the deadline is pushed out by `ttlMs` again).
 *
 * @returns {() => void}
 *   A **cleanup** function that removes listeners/timers without closing the page.
 *
 * @example
 * // Typical usage in a Puppeteer flow:
 * import puppeteer from 'puppeteer';
 *
 * const browser = await puppeteer.launch({ headless: false });
 * const page = await browser.newPage();
 *
 * // Auto-close the page after 2 minutes, close popups, and extend TTL on activity.
 * const disarm = armPageTTL(page, {
 *   ttlMs: 120_000,
 *   closePopups: true,
 *   closePopupsDelayMs: 1500,
 *   includePopupsInTTL: true,
 *   resetOnActivity: true,
 * });
 *
 * await page.goto('https://example.com', { waitUntil: 'domcontentloaded' });
 * // ... do your automation ...
 *
 * // If you finish early and want to keep the page open, disarm the TTL:
 * disarm();
 *
 * // Later, close things explicitly (good hygiene in pools/workers):
 * await page.close();
 * await browser.close();
 */
export function armPageTTL(page, {
  ttlMs = 60_000,
  closePopups = true,
  closePopupsDelayMs = 1500,   // 👈 NEW: give stealth a moment
  includePopupsInTTL = true,
  resetOnActivity = false,
} = {}) {
  const children = new Set();
  let deadline = Date.now() + ttlMs;
  let timer = schedule(deadline);

  function schedule(untilTs) {
    const ms = Math.max(0, untilTs - Date.now());
    return setTimeout(kill, ms);
  }
  async function kill() {
    try {
      if (includePopupsInTTL) {
        for (const p of children) {
          if (!p.isClosed()) await p.close().catch(() => { });
        }
      }
      if (!page.isClosed()) await page.close().catch(() => { });
    } finally {
      cleanup();
    }
  }
  function cleanup() {
    clearTimeout(timer);
    page.off('popup', onPopup);
    if (resetOnActivity) {
      page.off('framenavigated', onActivity);
      page.off('request', onActivity);
    }
  }
  function onPopup(p) {
    children.add(p);
    p.once('close', () => children.delete(p));
    if (closePopups) {
      setTimeout(() => { p.close().catch(() => { }); }, Math.max(0, closePopupsDelayMs));
    }
  }
  function onActivity() {
    if (!resetOnActivity) return;
    deadline = Date.now() + ttlMs;
    clearTimeout(timer);
    timer = schedule(deadline);
  }

  page.on('popup', onPopup);
  if (resetOnActivity) {
    page.on('framenavigated', onActivity);
    page.on('request', onActivity);
  }
  page.once('close', cleanup);

  return () => cleanup();
}

/**
 * Safely runs a function in the page context with `page.evaluate`, suppressing
 * the most common *transient* eval errors that happen during navigation/teardown.
 *
 * ### Why wrap `page.evaluate`?
 * `page.evaluate` (often called from “page.execute” style helpers) binds to a specific
 * execution context (the current document / frame). When a page navigates, a frame detaches,
 * or the tab closes while your evaluate is in-flight, Puppeteer throws errors like:
 *
 * - `Execution context was destroyed, most likely because of a navigation.`
 * - `Cannot find context with specified id`
 * - `Target closed`
 *
 * Those aren’t application bugs—just race conditions from legitimate navigations or TTL
 * cleanup. This wrapper converts ONLY those transient errors into `null` so your flow can
 * decide how to proceed (retry, skip, or record a “not available” value) without blowing up.
 * All other errors are rethrown so real problems aren’t hidden.
 *
 * Notes / Gotchas:
 * - This wrapper **does not retry**. If you want retries, wrap `safeEvaluate` in your own
 *   backoff policy when `null` is returned.
 * - Arguments passed to `fn` must be **serializable** (structured clone) as with `page.evaluate`.
 * - If you need to interact **after** a navigation, wait for the new document (e.g.,
 *   `await page.waitForNavigation()` or `waitForSelector`) and then call `safeEvaluate`.
 *
 * @template T
 * @param {import('puppeteer').Page | import('puppeteer').Frame | import('puppeteer').ElementHandle} page
 *        A Puppeteer `Page`, `Frame`, or `ElementHandle` providing an `evaluate` method.
 * @param {( ...args: any[] ) => T | Promise<T>} fn
 *        Function that will run in the browser context. Its return value is serialized back.
 * @param {...any} args
 *        Additional arguments passed to `fn`. Must be serializable.
 * @returns {Promise<T | null>}
 *          Resolves to the function's return value, or `null` if the evaluate failed due to
 *          a transient context/target error during navigation/close.
 *
 * @example
 * // Basic usage: read text content safely, tolerate navigations.
 * const title = await safeEvaluate(page, (sel) => {
 *   const el = document.querySelector(sel);
 *   return el ? el.textContent?.trim() : null;
 * }, 'h1');
 *
 * if (title === null) {
 *   // Page navigated or closed while evaluating; decide to retry or skip.
 *   console.warn('Title not available (nav/close during evaluate).');
 * }
 *
 * @example
 * // With a retry/backoff when transient errors happen:
 * async function safeEvalWithRetry(page, fn, ...args) {
 *   for (let attempt = 0; attempt < 3; attempt++) {
 *     const res = await safeEvaluate(page, fn, ...args);
 *     if (res !== null) return res;
 *     await new Promise(r => setTimeout(r, 300 * (attempt + 1))); // backoff
 *   }
 *   return null;
 * }
 *
 * const hrefs = await safeEvalWithRetry(page, () => [...document.links].map(a => a.href));
 *
 * @example
 * // In a popup or frame that may disappear:
 * const popup = await page.waitForEvent('popup', { timeout: 5000 }).catch(() => null);
 * if (popup) {
 *   const ua = await safeEvaluate(popup, () => navigator.userAgent);
 *   console.log('Popup UA:', ua); // ua may be null if popup closed itself
 * }
 */
export async function safeEvaluate(page, fn, ...args) {
  try {
    return await page.evaluate(fn, ...args);
  } catch (e) {
    const msg = String(e?.message || e);
    if (
      msg.includes('Execution context was destroyed') ||
      msg.includes('Cannot find context') ||
      msg.includes('Target closed')
    ) {
      return null;
    }
    throw e;
  }
}

/**
 * Clicks an element that *might* trigger a navigation, without hanging the test
 * if no navigation occurs. It fires the click and simultaneously waits for a
 * possible `page.waitForNavigation(...)`; if navigation doesn't happen within
 * the given timeout, the function just returns. A small randomized delay is
 * also used to mimic human interaction.
 *
 * ## Why this exists (reasoning)
 * In real sites, a click may:
 * - Navigate the same tab (server-rendered pages),
 * - Update the URL without a full navigation (SPA client routing),
 * - Open a popup/tab (`target="_blank"`), or
 * - Do nothing due to JS guards, A/B, or race conditions.
 *
 * Naively calling `await page.waitForNavigation()` after every click causes
 * flakiness and timeouts when no navigation occurs. This helper races the click
 * against a best-effort navigation wait and a short randomized sleep so your
 * flow keeps moving whether navigation happens or not—reducing brittle tests.
 *
 * ⚠️ Notes & caveats
 * - If you expect a **popup**, this helper won’t catch it. Pair it with
 *   `page.waitForEvent('popup')` (see Example 3).
 * - Errors in the click/navigation are intentionally **swallowed** (via
 *   `Promise.allSettled`) to avoid breaking the flow. If you need strict
 *   failures, add your own assertions after calling this helper.
 * - `handleOrSelector` should be an `ElementHandle`. If you prefer to pass a
 *   CSS selector, use the `options.selector` parameter (see examples).
 *
 * @example <caption>1) Typical anchor that may or may not reload the page</caption>
 * import { sleep } from './utils/sleep.js';
 * // ... ensure the element exists first
 * const link = await page.$('a.product-link');
 * await clickPossiblyNavigates(page, link, { timeout: 8000 });
 * // If it *did* navigate, DOM is the new page; otherwise, continue on same page.
 *
 * @example <caption>2) Using the selector option (no ElementHandle)</caption>
 * await page.waitForSelector('#buy-now', { visible: true });
 * await clickPossiblyNavigates(page, null, { selector: '#buy-now', timeout: 10000 });
 * // For SPA flows, follow up with a specific UI wait:
 * await page.waitForSelector('[data-testid="cart"]', { timeout: 15000 });
 *
 * @example <caption>3) Link that sometimes opens a popup</caption>
 * const popupPromise = page.waitForEvent('popup').catch(() => null);
 * await clickPossiblyNavigates(page, null, { selector: 'a.external' });
 * const popup = await popupPromise; // may be null if no popup opened
 * if (popup) {
 *   await popup.waitForLoadState?.('domcontentloaded').catch(() => {});
 *   // ...work with the popup page...
 * }
 *
 * @param {import('puppeteer').Page} page
 *   The Puppeteer Page instance.
 * @param {import('puppeteer').ElementHandle<Element>|null} handleOrSelector
 *   An element handle to click. If you don't have one, pass `null` and provide
 *   `options.selector`.
 * @param {Object} [options]
 * @param {number} [options.timeout=15000]
 *   Max time to wait for a potential navigation (ms). If it times out, no error
 *   is thrown and the function returns.
 * @param {string|null} [options.selector=null]
 *   CSS selector to click instead of providing an ElementHandle. When set, the
 *   function calls `page.click(selector, ...)`.
 * @returns {Promise<void>} Resolves when either a navigation is observed or the
 *   short randomized delay elapses—whichever comes first.
 */
export async function clickPossiblyNavigates(page, handleOrSelector, { timeout = 15000, selector = null } = {}) {
  const clickPromise = (async () => {
    if (selector) {
      await page.click(selector, { delay: Math.floor(Math.random() * 120) });
    } else {
      await handleOrSelector.click({ delay: Math.floor(Math.random() * 120) });
    }
  })();

  const navPromise = page
    .waitForNavigation({ waitUntil: 'domcontentloaded', timeout })
    .catch(() => null);

  // Use a small random pause so we don't immediately blast past UI handlers.
  await Promise.race([
    Promise.allSettled([clickPromise, navPromise]),
    sleep.random(800, 1500),
  ]);
}

// helpers/puppeteer.js

/**
 * Waits for a popup (`page.once('popup')`) but gives up after `ms`.
 *
 * ## Why this exists
 * Many links conditionally open a new tab/window (`target="_blank"`) only some
 * of the time (A/B, anti-bot, geo, etc.). Blocking unconditionally on
 * `page.waitForEvent('popup')` can hang the flow. This helper races that wait
 * against a timeout and returns `null` if no popup appears.
 *
 * @example <caption>Pair with a click that may open a popup</caption>
 * import { waitForPopupOrTimeout, clickPossiblyNavigates } from './helpers/puppeteer.js';
 *
 * const popupPromise = waitForPopupOrTimeout(page, 8000);
 * await clickPossiblyNavigates(page, null, { selector: 'a.external' });
 * const popup = await popupPromise; // Page | null
 * if (popup) {
 *   await popup.waitForLoadState?.('domcontentloaded').catch(() => {});
 *   // ... use popup ...
 * }
 *
 * @param {import('puppeteer').Page} page - The parent page that will spawn the popup.
 * @param {number} [ms=8000] - Milliseconds to wait before returning `null`.
 * @returns {Promise<import('puppeteer').Page|null>} A popup Page if one appeared, else `null`.
 */
export function waitForPopupOrTimeout(page, ms = 8000) {
  return Promise.race([
    new Promise(resolve => page.once('popup', resolve)),
    new Promise(resolve => setTimeout(() => resolve(null), ms)),
  ]);
}

/**
 * Waits for a popup with an explicit listener you can later remove; returns `null`
 * if no popup appears before `ms`.
 *
 * ## Why this exists
 * Unlike {@link waitForPopupOrTimeout} (which uses `Promise.race`), this version
 * cleans up the event listener on timeout to avoid dangling listeners during long
 * test runs. Use it when you’re repeatedly probing for popups.
 *
 * @example <caption>With a resilient click + navigation helper</caption>
 * import { waitForPopupWithTimeout, clickPossiblyNavigates } from './helpers/puppeteer.js';
 *
 * const popupPromise = waitForPopupWithTimeout(page, 7000);
 * await clickPossiblyNavigates(page, null, { selector: 'a.maybe-opens' });
 * const popup = await popupPromise;
 * if (popup) {
 *   await popup.bringToFront().catch(() => {});
 * }
 *
 * @param {import('puppeteer').Page} page - The parent page that may spawn a popup.
 * @param {number} [ms=8000] - Milliseconds to wait before returning `null`.
 * @returns {Promise<import('puppeteer').Page|null>} A popup Page if one appeared, else `null`.
 */
export function waitForPopupWithTimeout(page, ms = 8000) {
  return new Promise(resolve => {
    const onPopup = (p) => { clearTimeout(timer); resolve(p); };
    const timer = setTimeout(() => {
      page.off('popup', onPopup);
      resolve(null);
    }, ms);
    page.once('popup', onPopup);
  });
}

/**
 * Clicks a link that should open in a new tab, handling tricky cases:
 * - Scrolls it into view,
 * - Forces `target="_blank"` and safe `rel` attrs,
 * - Falls back to a DOM `click()` if the real click is intercepted,
 * - Skips clicking if the selector appears inside a **cross-origin** iframe
 *   (to avoid "Node is detached / not clickable" errors).
 *
 * ## Why this exists
 * Real-world ads/affiliate links are often overlapped, off-viewport, or wrapped
 * in layers that intercept clicks. A straight `page.click(selector)` fails a lot.
 * This helper increases the success rate while staying “human-like”.
 *
 * ## Using with `clickPossiblyNavigates`
 * This helper tries to open a **new tab**. Combine it with a popup waiter:
 *
 * @example <caption>Resilient open-in-new-tab + wait for popup</caption>
 * import {
 *   clickNewTabLinkResilient,
 *   waitForPopupWithTimeout,
 *   waitForPopupOrTimeout
 * } from './helpers/puppeteer.js';
 * import { clickPossiblyNavigates } from './helpers/puppeteer.js';
 *
 * // Option A: use this helper + popup waiters
 * const popupP = waitForPopupWithTimeout(page, 8000);
 * const clicked = await clickNewTabLinkResilient(page, 'a.exo-native-widget-item');
 * const popup = await popupP; // Page | null
 *
 * // Option B: if you don't need resilient behavior, you can use clickPossiblyNavigates:
 * const popupP2 = waitForPopupOrTimeout(page, 8000);
 * await clickPossiblyNavigates(page, null, { selector: 'a.exo-native-widget-item' });
 * const popup2 = await popupP2;
 *
 * @param {import('puppeteer').Page} page - The page containing the link.
 * @param {string} selector - CSS selector for the anchor/link to click.
 * @returns {Promise<boolean>} `true` if a click attempt was made; `false` if not found or inside a cross-origin iframe.
 */
export async function clickNewTabLinkResilient(page, selector) {
  // Quick guard: if it's inside any iframe, bail (simple heuristic)
  const frames = page.frames();
  for (const f of frames) {
    try {
      if (f !== page.mainFrame() && await f.$(selector)) {
        // Likely not clickable from main frame (and may be cross-origin)
        console.log('Element appears inside an iframe; skipping main-page click.');
        return false;
      }
    } catch {
      // ignore frame access errors
    }
  }

  // Prepare the element in-page (target=_blank, rel, scroll into view)
  await page.evaluate((sel) => {
    const a = document.querySelector(sel);
    if (a) {
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      try { a.scrollIntoView({ block: 'center', inline: 'center' }); } catch { }
    }
  }, selector);

  const handle = await page.$(selector);
  if (!handle) return false;

  // Try a real click first (user gesture)
  try {
    await handle.click({ delay: Math.floor(Math.random() * 120) });
    await handle.dispose().catch(() => { });
    return true;
  } catch {
    // Fallback: DOM click (works even if covered)
    try {
      await page.evaluate((sel) => {
        document.querySelector(sel)?.click();
      }, selector);
      await handle.dispose().catch(() => { });
      return true;
    } catch {
      await handle.dispose().catch(() => { });
      return false;
    }
  }
}

// helpers/puppeteer.mjs

/**
 * Apply UA & UA-CH *network-level* overrides using the Chrome DevTools Protocol.
 * Ensures the browser actually sends headers consistent with your profile.
 *
 * @param {import('puppeteer').Page} page
 * @param {import('../ua.mjs').UAProfile} profile
 */
export async function applyUAOnNetwork(page, profile) {
  const client = await page.target().createCDPSession();

  // Translate our UAProfile → CDP userAgentMetadata shape
  const isMobile = profile.deviceCategory !== "desktop";
  const os = profile.osName; // "Windows"|"macOS"|"Linux"|"Android"|"iOS"

  // Build UA-CH brand lists from profile.browserVersion
  const ua = profile.uaString || "";
  const major = (profile.browserVersion || "").split(".")[0] || "120";
  const brand = /Edge/i.test(profile.browserName) ? "Microsoft Edge" :
    /Chromium/i.test(profile.browserName) ? "Chromium" : "Google Chrome";

  const brands = [
    { brand: "Not;A=Brand", version: "99" },
    { brand, version: String(major) },
    { brand: "Chromium", version: String(major) },
  ];

  const fullVersionList = [
    { brand: "Not;A=Brand", version: "99.0.0.0" },
    { brand, version: profile.browserVersion || `${major}.0.0.0` },
    { brand: "Chromium", version: profile.browserVersion || `${major}.0.0.0` },
  ];

  // Some Chrome versions accept bitness/wow64/architecture fields
  const arch = /Windows|Linux/.test(os) ? "x86" : "arm";
  const metadata = {
    brands,
    fullVersion: profile.browserVersion || `${major}.0.0.0`,
    fullVersionList,
    platform: os,                         // "Windows"|"macOS"|"Linux"|"Android"|"iOS"
    platformVersion: (profile.clientHints?.['Sec-CH-UA-Platform-Version'] || '"0.0.0"').replace(/"/g, ''),
    architecture: arch,                   // "x86"|"arm"
    model: profile.model || "",
    mobile: isMobile,
    bitness: "64",
    wow64: false
  };

  await client.send('Network.setUserAgentOverride', {
    userAgent: profile.uaString,
    userAgentMetadata: metadata
  });
}

/**
 * Apply UA & UA-CH *JS-surface* overrides (Navigator shims) *before* any site JS runs.
 * Keeps window.navigator* fields consistent with the network headers.
 *
 * @param {import('puppeteer').Page} page
 * @param {import('../ua.mjs').UAProfile} profile
 */
export async function installNavigatorShims(page, profile) {
  const isMobile = profile.deviceCategory !== "desktop";
  const os = profile.osName;
  const arch = /Windows|Linux/.test(os) ? "x86" : "arm";
  const ch = profile.clientHints || {};  // already-formatted Sec-CH-* values

  await page.evaluateOnNewDocument((params) => {
    const {
      uaString, os, isMobile, arch, clientHints, viewport, hwCores, memGB, model
    } = params;

    const define = (obj, prop, value) => {
      try { Object.defineProperty(obj, prop, { get: () => value, configurable: true }); } catch { }
    };

    // Basic navigator surfaces
    define(navigator, 'userAgent', uaString);
    define(navigator, 'platform',
      os === "Windows" ? "Win32" :
        os === "macOS" ? "MacIntel" :
          os === "Android" ? "Linux armv8l" :
            os === "iOS" ? "iPhone" :
              "Linux x86_64");

    define(navigator, 'vendor', "Google Inc.");
    define(navigator, 'hardwareConcurrency', hwCores);

    // Device Memory is not universally present; gate the define:
    if ('deviceMemory' in navigator) define(navigator, 'deviceMemory', memGB);

    // Touch points
    define(navigator, 'maxTouchPoints', isMobile ? 5 : 0);

    // userAgentData shim (low- & high-entropy getters).
    // We simulate *exactly* what our network headers claim.
    const major = (() => {
      const m = uaString.match(/(?:Chrome|Chromium|Edg)\/(\d+)/);
      return m ? m[1] : "120";
    })();

    const realBrand = /Edg\//.test(uaString) ? "Microsoft Edge" :
      /Chromium\//.test(uaString) ? "Chromium" : "Google Chrome";

    const brands = [
      { brand: "Not;A=Brand", version: "99" },
      { brand: realBrand, version: major },
      { brand: "Chromium", version: major },
    ];

    const fullVersion = (() => {
      const m = uaString.match(/(?:Edg|Chrome|Chromium)\/(\d+\.\d+\.\d+\.\d+)/);
      return m ? m[1] : `${major}.0.0.0`;
    })();

    const fullVersionList = [
      { brand: "Not;A=Brand", version: "99.0.0.0" },
      { brand: realBrand, version: fullVersion },
      { brand: "Chromium", version: fullVersion },
    ];

    const uaData = {
      brands,
      mobile: isMobile,
      platform: os,
      getHighEntropyValues: async (hints) => {
        const data = {
          architecture: arch,                 // "x86" | "arm"
          bitness: "64",
          model: model || "",
          platformVersion: (clientHints['Sec-CH-UA-Platform-Version'] || '"0.0.0"').replace(/"/g, ''),
          uaFullVersion: fullVersion,
          fullVersionList,
          wow64: false,
          formFactors: [isMobile ? "Mobile" : "Desktop"]
        };
        const out = {};
        for (const h of hints || []) if (h in data) out[h] = data[h];
        return out;
      },
      toJSON() { return { brands, mobile: isMobile, platform: os }; }
    };

    define(navigator, 'userAgentData', uaData);

    // Some common stealth fixes (reduce headless fingerprints)
    try {
      Object.defineProperty(navigator, 'webdriver', { get: () => false, configurable: true });
    } catch { }

    // Fake plugins/mimeTypes
    try {
      const fakePluginArray = { length: 3, 0: {}, 1: {}, 2: {} };
      define(navigator, 'plugins', fakePluginArray);
      const fakeMimeTypes = { length: 2, 0: {}, 1: {} };
      define(navigator, 'mimeTypes', fakeMimeTypes);
    } catch { }

    // window.chrome presence
    try {
      if (!window.chrome) Object.defineProperty(window, 'chrome', { value: { runtime: {} }, configurable: true });
    } catch { }

    // Languages
    try {
      define(navigator, 'language', 'en-US');
      define(navigator, 'languages', ['en-US', 'en']);
    } catch { }

    // DPR + screen geometry
    try {
      define(window, 'devicePixelRatio', Math.max(1, Math.min(4, Math.round((viewport.dpr || 1) * 100) / 100)));
      define(screen, 'width', viewport.width);
      define(screen, 'height', viewport.height);
      define(screen, 'availWidth', viewport.width);
      define(screen, 'availHeight', viewport.height);
      define(screen, 'colorDepth', 24);
      define(screen, 'pixelDepth', 24);
    } catch { }

    // Permissions stealth (notifications) – prevent the infamous prompt mismatch
    if (navigator.permissions && navigator.permissions.query) {
      const orig = navigator.permissions.query.bind(navigator.permissions);
      navigator.permissions.query = (p) => {
        if (p && p.name === 'notifications') {
          return Promise.resolve({ state: Notification.permission });
        }
        return orig(p);
      };
    }
  }, {
    uaString: profile.uaString,
    os,
    isMobile,
    arch,
    clientHints: ch,
    viewport: { width: profile.viewport.width, height: profile.viewport.height, dpr: profile.dpr },
    hwCores: profile.hardwareConcurrency,
    memGB: profile.deviceMemoryGB,
    model: profile.model || ""
  });
}

/**
 * A convenience that applies *both* the network override and the JS shims,
 * plus sets viewport to match your profile.
 *
 * @param {import('puppeteer').Page} page
 * @param {import('../ua.mjs').UAProfile} profile
 */
export async function applyProfileToPage(page, profile) {
  await page.setUserAgent(profile.uaString);
  await page.setViewport({
    width: profile.viewport.width,
    height: profile.viewport.height,
    deviceScaleFactor: profile.dpr,
    isMobile: profile.deviceCategory !== "desktop",
    hasTouch: profile.deviceCategory !== "desktop",
  });

  await applyUAOnNetwork(page, profile);
  await installNavigatorShims(page, profile);
}

/**
 * Install prototype methods on Puppeteer's Page so you can:
 *   - await page.injectScript('lib/jquery.js')
 *   - await page.injectJquery()  // or pass a local path
 *
 * Why create this helper (and why bypass CSP)?
 * Many real-world sites ship strict Content Security Policies that block
 * third-party and inline scripts unless they carry a matching nonce/hash.
 * Puppeteer’s `page.setBypassCSP(true)` tells Chrome to ignore CSP for the tab,
 * which lets us inject local helpers (like jQuery) reliably. We inject as
 * **inline content** from disk to avoid flaky network fetches that CSP or
 * anti-bot middleware would otherwise block.
 *
 * Usage:
 *   import { installPageExtensions } from './helpers/page-extensions.mjs'
 *   const page = await browser.newPage();
 *   installPageExtensions(page); // patch Page.prototype once per process
 *
 *   await page.goto('https://example.org', { waitUntil: 'domcontentloaded' });
 *   await page.injectScript('lib/jquery.js'); // local path → inline inject
 *   const ver = await page.evaluate(() => $.fn.jquery);
 *   console.log('jQuery:', ver);
 *
 * @param {import('puppeteer').Page | import('puppeteer-core').Page} page
 */
export function installPageExtensions(page) {
  const proto = Object.getPrototypeOf(page);
  if (!proto || typeof proto.addScriptTag !== 'function') {
    throw new Error('installPageExtensions: argument is not a Puppeteer Page.');
  }

  /**
   * Inject a script into the current page with CSP bypass and optional readiness check.
   *
   * Behavior:
   * - If `pathOrUrl` starts with http(s), we inject via `{ url }` (works best with bypassCSP).
   * - Otherwise we treat it as a filesystem path and inject **inline** via `{ content }`.
   *
   * @param {string} pathOrUrl Local file path (recommended) or an http(s) URL.
   * @param {Object} [options]
   * @param {boolean} [options.bypassCSP=true] Call `page.setBypassCSP(true)` first.
   * @param {() => unknown} [options.readyFunction] Page-world predicate to confirm readiness.
   * @param {number} [options.readyTimeout=10000] Timeout for the readiness predicate.
   * @returns {Promise<void>}
   */
  if (!proto.injectScript) {
    proto.injectScript = async function injectScript(
      pathOrUrl,
      { bypassCSP = true, readyFunction, readyTimeout = 10_000 } = {}
    ) {
      if (bypassCSP) await this.setBypassCSP(true);

      const isHttp = /^https?:\/\//i.test(pathOrUrl);
      if (isHttp) {
        await this.addScriptTag({ url: pathOrUrl });
      } else {
        // Resolve to an absolute path relative to CWD to be explicit/cross-platform.
        const absPath = path.isAbsolute(pathOrUrl) ? pathOrUrl : path.resolve(process.cwd(), pathOrUrl);
        const src = await readFile(absPath, 'utf8');
        await this.addScriptTag({ content: src });
      }

      if (typeof readyFunction === 'function') {
        await this.waitForFunction(readyFunction, { timeout: readyTimeout });
      }
    };
  }

  /**
   * Convenience wrapper that injects jQuery from a local path, or auto-resolves
   * the npm package build if you don’t pass one (Node 20+/22+: uses import.meta.resolve).
   *
   * @param {Object} [options]
   * @param {string} [options.jqueryPath] Local path to your jQuery build (e.g., 'lib/jquery.js').
   * @param {boolean} [options.bypassCSP=true] Whether to bypass CSP before injection.
   * @param {number} [options.readyTimeout=10000] Timeout for verifying jQuery presence.
   * @returns {Promise<void>}
   *
   * @example
   * await page.injectJquery({ jqueryPath: 'lib/jquery.js' });
   * const text = await page.evaluate(() => $('h1').text());
   */
  if (!proto.injectJquery) {
    proto.injectJquery = async function injectJquery({
      jqueryPath,                 // e.g., 'lib/jquery.js'
      bypassCSP = true,
      readyTimeout = 10_000,
    } = {}) {
      // 1) Resolve a local path to jQuery (your 'lib/jquery.js' is ideal).
      let resolvedPath = jqueryPath;
      if (!resolvedPath) {
        // Prefer a pinned local file, but if you truly want npm's build:
        // Node 20+/22+:
        const url = await import.meta.resolve('jquery/dist/jquery.min.js');
        resolvedPath = (await import('node:url')).fileURLToPath(url);
      }

      // 2) Inject the script (inline), bypassing CSP if requested.
      await this.injectScript(resolvedPath, {
        bypassCSP,
        // Only require window.jQuery to exist; do NOT require window.$
        readyFunction: () =>
          typeof window !== 'undefined' &&
          !!window.jQuery &&
          !!window.jQuery.fn &&
          !!window.jQuery.fn.jquery,
        readyTimeout,
      });

      // 3) Create an isolated, conflict-free handle so site JS can't break you.
      //    - noConflict(true) removes both $ and jQuery globals and returns the jQuery object.
      //    - We stash that on window.$jq for our exclusive use.
      await this.evaluate(() => {
        const jq = window.jQuery;
        if (!jq) return false;
        // If noConflict exists, detach from globals; keep our private handle.
        // Some custom builds may not include noConflict; then just reuse jq.
        const ours = typeof jq.noConflict === 'function' ? jq.noConflict(true) : jq;
        // Keep a stable, non-colliding reference:
        window.$jq = ours;
        return !!window.$jq && !!window.$jq.fn && !!window.$jq.fn.jquery;
      });

      // 4) Optional: final guard to ensure $jq is live
      await this.waitForFunction(
        () => !!window.$jq && !!window.$jq.fn && !!window.$jq.fn.jquery,
        { timeout: readyTimeout }
      );
    };
  }
}

/**
 * Return a JSHandle to the page's global `window` object.
 * NOTE:
 *   - You cannot use this handle across navigations (it becomes invalid).
 *   - Dispose it when done: `await handle.dispose()`.
 */
// puppeteer.Page.prototype.getWindowHandle = async function () {
//   // Wait until a document exists (and thus `window` too)
//   await this.waitForFunction(() => !!window, { timeout: 0 });
//   return await this.evaluateHandle(() => window);
// };

// /**
//  * Run a function inside the page context (has direct access to `window`).
//  * Pass only serializable args. The function must be self-contained (no Node closures).
//  *
//  * @example
//  * await page.withWindow((w) => w.location.href);
//  */
// puppeteer.Page.prototype.withWindow = async function (pageFn, ...args) {
//   if (typeof pageFn !== "function") {
//     throw new TypeError("withWindow(pageFn, ...args): pageFn must be a function");
//   }
//   // We call your function as (window, ...args) inside the page.
//   return await this.evaluate((fnSource, _args) => {
//     const fn = new Function("window", "args", `return (${fnSource})(window, ...args);`);
//     return fn(window, _args);
//   }, pageFn.toString(), args);
// };

// /**
//  * Snapshot a few useful `window`/`navigator`/`screen` properties.
//  * Customize with `pick` (dot-paths from window).
//  */
// puppeteer.Page.prototype.windowSnapshot = async function (opts = {}) {
//   const pick = opts.pick || [
//     "location.href",
//     "navigator.userAgent",
//     "navigator.platform",
//     "navigator.language",
//     "navigator.languages",
//     "navigator.webdriver",
//     "screen.width",
//     "screen.height",
//     "devicePixelRatio",
//     "document.visibilityState",
//   ];
//   return await this.evaluate((paths) => {
//     const get = (path) => {
//       try { return path.split(".").reduce((acc, k) => acc?.[k], window); } catch { return undefined; }
//     };
//     const out = {};
//     for (const p of paths) out[p] = get(p);
//     return out;
//   }, pick);
// };
