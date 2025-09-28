// helpers/ua.mjs
import UserAgent from "user-agents";
import { pickWeighted } from "./utils.mjs"; // removed `random` import

/**
 * @module helpers/ua
 * Utilities for generating realistic, distribution-weighted 2025 user-agents and
 * building matching HTTP request headers (Chromium Client Hints included when appropriate).
 *
 * Notes:
 * - This version parses **full** Chromium-family versions from UA (e.g., 139.0.7258.128)
 *   and reflects them in UA-CH:
 *     - Sec-CH-UA ............... → major versions (e.g., "139")
 *     - Sec-CH-UA-Full-Version .. → full product version (e.g., "139.0.7258.128")
 *     - Sec-CH-UA-Full-Version-List → includes Not;A=Brand @ 99.0.0.0, Product @ full, Chromium @ full
 * - Brand order matches what you see in DevTools:
 *     "Not;A=Brand", then "Google Chrome"/"Microsoft Edge", then "Chromium"
 */

/* ------------------------------------------------------------------ *
 * Internal helpers
 * ------------------------------------------------------------------ */

/** Safe constructor for user-agents */
function tryNewUA(opts) {
  try { return new UserAgent(opts); } catch { return null; }
}

/** Infer platform label from UA text (fallback) */
function inferPlatformFromUA(ua) {
  if (/Android/i.test(ua)) return "Android";
  if (/iPhone|iPad|iPod/i.test(ua)) return "iOS";
  if (/Windows NT/i.test(ua)) return "Windows";
  if (/Mac OS X|Macintosh/i.test(ua)) return "macOS";
  if (/Linux/i.test(ua)) return "Linux";
  return "Unknown";
}

/**
 * Parse Chromium-family versions from a UA string.
 * Returns the **product brand** (Chrome or Edge when present), its full & major version,
 * and also the Chromium token full/major (from "Chrome/" or "Chromium/").
 *
 * @param {string} ua
 * @returns {{
 *   brand: "Google Chrome"|"Microsoft Edge"|"Chromium",
 *   brandFull: string,
 *   brandMajor: string,
 *   chromiumFull: string,
 *   chromiumMajor: string
 * }}
 */
function parseChromiumVersions(ua) {
  const mEdge = ua.match(/Edg(?:e|A|iOS)?\/(\d+\.\d+\.\d+\.\d+)/);
  const mChrome = ua.match(/Chrome\/(\d+\.\d+\.\d+\.\d+)/);
  const mChromium = ua.match(/Chromium\/(\d+\.\d+\.\d+\.\d+)/);

  if (mEdge) {
    const brandFull = mEdge[1];
    const brandMajor = brandFull.split(".")[0];
    const chromiumFull = (mChrome?.[1] || mChromium?.[1] || brandFull);
    const chromiumMajor = chromiumFull.split(".")[0];
    return { brand: "Microsoft Edge", brandFull, brandMajor, chromiumFull, chromiumMajor };
  }

  if (mChrome) {
    const brandFull = mChrome[1];
    const brandMajor = brandFull.split(".")[0];
    const chromiumFull = (mChromium?.[1] || brandFull);
    const chromiumMajor = chromiumFull.split(".")[0];
    return { brand: "Google Chrome", brandFull, brandMajor, chromiumFull, chromiumMajor };
  }

  if (mChromium) {
    const brandFull = mChromium[1];
    const brandMajor = brandFull.split(".")[0];
    return { brand: "Chromium", brandFull, brandMajor, chromiumFull: brandFull, chromiumMajor: brandMajor };
  }

  const fallback = "120.0.0.0";
  return {
    brand: "Google Chrome",
    brandFull: fallback,
    brandMajor: "120",
    chromiumFull: fallback,
    chromiumMajor: "120",
  };
}

/** Is this a Chromium-family product that should send UA-CH? */
function isChromium(browserName) {
  return /Chrome|Chromium|Edge|Brave|Opera/i.test(browserName || "");
}

/** Build Sec-CH-UA (major-only) with canonical brand order */
function chMajorList(brand, brandMajor, chromiumMajor) {
  const p = brand || "Google Chrome";
  const bm = brandMajor || "120";
  const cm = chromiumMajor || bm;
  return `"Not;A=Brand";v="99", "${p}";v="${bm}", "Chromium";v="${cm}"`;
}

/** Build Sec-CH-UA-Full-Version-List with canonical order */
function chFullList(brand, brandFull, chromiumFull) {
  const p = brand || "Google Chrome";
  const bf = brandFull || "120.0.0.0";
  const cf = chromiumFull || bf;
  return `"Not;A=Brand";v="99.0.0.0", "${p}";v="${bf}", "Chromium";v="${cf}"`;
}

/** Platform label mapping */
const PLATFORM_LABEL = {
  Windows: "Windows",
  macOS: "macOS",
  Linux: "Linux",
  Android: "Android",
  iOS: "iOS",
};

/** Plausible Client Hints platform version */
function chPlatformVersion(osName) {
  if (osName === "Windows") return "10.0.0";
  if (osName === "macOS")   return "14.0.0";
  if (osName === "Android") return "14.0.0";
  if (osName === "iOS")     return "17.0.0";
  if (osName === "Linux")   return "6.0.0";
  return "0.0.0";
}

/* ------------------------------------------------------------------ *
 * Distributions (tweak as desired)
 * ------------------------------------------------------------------ */

const DEVICE_MIX = [
  { key: "mobile", w: 0.60 },
  { key: "desktop", w: 0.35 },
  { key: "tablet", w: 0.05 },
];

const MOBILE_OS_MIX = [
  { key: "Android", w: 0.65 },
  { key: "iOS",     w: 0.35 },
];

const ANDROID_VENDOR_MIX = [
  { key: "Samsung", w: 0.40 },
  { key: "Xiaomi",  w: 0.15 },
  { key: "Google",  w: 0.10 },
  { key: "OnePlus", w: 0.10 },
  { key: "Oppo",    w: 0.10 },
  { key: "Other",   w: 0.15 },
];

const DESKTOP_OS_MIX = [
  { key: "Windows", w: 0.65 },
  { key: "macOS",   w: 0.30 },
  { key: "Linux",   w: 0.05 },
];

const DESKTOP_BROWSER_MIX = {
  Windows: [
    { key: "Chrome", w: 0.65 },
    { key: "Edge",   w: 0.20 },
    { key: "Firefox",w: 0.15 },
  ],
  macOS: [
    { key: "Safari", w: 0.60 },
    { key: "Chrome", w: 0.40 },
  ],
  Linux: [
    { key: "Chrome",  w: 0.70 },
    { key: "Firefox", w: 0.30 },
  ],
};

// iOS buckets → viewport/DPR families (models aren’t in UA)
const IOS_PHONE_BUCKETS = [
  { name: "iPhone X/11 Pro",  w: 0.10, vp: [375, 812], dpr: 3 },
  { name: "iPhone 11/12/13",  w: 0.25, vp: [390, 844], dpr: 3 },
  { name: "iPhone 14/15",     w: 0.40, vp: [393, 852], dpr: 3 },
  { name: "iPhone 16",        w: 0.25, vp: [402, 874], dpr: 3 },
];

const ANDROID_SAMSUNG_MODELS = [
  { model: "SM-S928", name: "Galaxy S24 Ultra", w: 0.30, vp: [412, 915], dpr: 3 },
  { model: "SM-S926", name: "Galaxy S24+",      w: 0.20, vp: [384, 854], dpr: 3 },
  { model: "SM-S921", name: "Galaxy S24",       w: 0.20, vp: [360, 780], dpr: 3 },
  { model: "SM-S916", name: "Galaxy S23+",      w: 0.15, vp: [384, 854], dpr: 3 },
  { model: "SM-A556", name: "Galaxy A55",       w: 0.15, vp: [412, 915], dpr: 2.5 },
];

const ANDROID_OTHER_MODELS = [
  { model: "Pixel 8",     token: "Pixel 8",     w: 0.30, vp: [412, 915], dpr: 2.625 },
  { model: "Pixel 8 Pro", token: "Pixel 8 Pro", w: 0.20, vp: [412, 915], dpr: 3 },
  { model: "OnePlus 12",  token: "CPH2581",     w: 0.20, vp: [412, 919], dpr: 3 },
  { model: "Xiaomi 14",   token: "2208",        w: 0.30, vp: [393, 873], dpr: 3 },
];

const TABLET_BUCKETS = [
  { name: "iPad",    w: 0.70, vp: [820, 1180], dpr: 2 },
  { name: "Android", w: 0.30, vp: [800, 1280], dpr: 2 },
];

const DESKTOP_VIEWPORTS = [
  [1280, 720],
  [1366, 768],
  [1440, 900],
  [1536, 864],
  [1600, 900],
  [1920, 1080],
];

/**
 * Pick realistic hardware for the chosen device segment.
 */
function pickHardware(deviceCategory, osName, modelHint) {
  if (deviceCategory === "desktop") {
    const vp = DESKTOP_VIEWPORTS.random();
    const cores = [4, 8, 8, 12, 16].random();
    const mem  = [8, 8, 16, 16, 32].random();
    return { viewport: { width: vp[0], height: vp[1] }, dpr: 1, cores, memoryGB: mem };
  }
  if (deviceCategory === "tablet") {
    const bucket = pickWeighted(TABLET_BUCKETS);
    const b = TABLET_BUCKETS.find(x => x.name === (bucket.name || bucket));
    const [width, height] = b.vp;
    const cores = [4, 6, 8].random();
    const mem  = [3, 4, 6, 8].random();
    return { viewport: { width, height }, dpr: b.dpr, cores, memoryGB: mem };
  }
  // mobile
  if (osName === "iOS") {
    const bucket = pickWeighted(IOS_PHONE_BUCKETS);
    const b = IOS_PHONE_BUCKETS.find(x => x.name === (bucket.name || bucket));
    const [width, height] = b.vp;
    const cores = 6;
    const mem  = [4, 6, 6, 8].random();
    return { viewport: { width, height }, dpr: b.dpr, cores, memoryGB: mem, model: b.name };
  } else {
    // Android
    const d = modelHint || pickWeighted(ANDROID_SAMSUNG_MODELS);
    const model = typeof d === "string" ? d : (d.model || d.name);
    const found = ANDROID_SAMSUNG_MODELS.find(x => x.model === model)
               || ANDROID_OTHER_MODELS.find(x => x.model === model || x.token === model)
               || ANDROID_SAMSUNG_MODELS[0];
    const [width, height] = found.vp;
    const cores = [4, 6, 8].random();
    const mem  = [3, 4, 6, 8].random();
    return { viewport: { width, height }, dpr: found.dpr, cores, memoryGB: mem, model: found.name || found.model };
  }
}

/**
 * Build a `user-agents` filter aligned with our target segment.
 */
function buildUAFilter({ deviceCategory, osName, browserName, vendorHint, modelToken }) {
  return (ua) => {
    if (ua.deviceCategory !== deviceCategory) return false;

    if (osName) {
      if ((ua.osName || "").toLowerCase() !== osName.toLowerCase()) return false;
    }
    if (browserName) {
      if (!new RegExp(browserName, "i").test(ua.browserName || "")) return false;
    }
    if (vendorHint && /Android/i.test(osName || "")) {
      const s = ua.userAgent || "";
      if (/Samsung/i.test(vendorHint) && !/SM-|Samsung/i.test(s)) return false;
      if (/Pixel|Google/i.test(vendorHint) && !/Pixel/i.test(s)) return false;
      if (/OnePlus/i.test(vendorHint) && !/OnePlus|CPH/i.test(s)) return false;
      if (/Xiaomi/i.test(vendorHint) && !/Xiao|Mi|M210|220|230|240/i.test(s)) return false;
      if (/Oppo/i.test(vendorHint) && !/OPPO|CPH/i.test(s)) return false;
    }
    // iOS Safari (exclude CriOS/FxiOS)
    if (osName === "iOS" && browserName === "Safari") {
      const s = ua.userAgent || "";
      if (!/Safari/.test(s) || /CriOS|FxiOS/.test(s)) return false;
    }
    return true;
  };
}

/**
 * Backoff picker to avoid "No user agents matched your filters."
 */
function pickUAWithBackoff(params) {
  const { deviceCategory, osName, browserName } = params;

  const strict = { deviceCategory, filter: buildUAFilter(params) };
  const byBrand = browserName ? { deviceCategory, userAgent: new RegExp(browserName, "i") } : null;
  const byOS = osName ? { deviceCategory, userAgent: new RegExp(osName, "i") } : null;

  const attempts = [strict, byBrand, byOS, { deviceCategory }, {}].filter(Boolean);

  for (const f of attempts) {
    const ua = tryNewUA(f);
    if (ua) return { uaObj: ua, uaString: ua.toString() };
  }

  // Static last-resort UA strings (category-aware)
  if (deviceCategory === "mobile" && osName === "Android") {
    const s =
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";
    return { uaObj: null, uaString: s };
  }
  if (deviceCategory === "mobile" && osName === "iOS") {
    const s =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
    return { uaObj: null, uaString: s };
  }
  if (deviceCategory === "tablet") {
    if (osName === "iOS") {
      const s =
        "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
      return { uaObj: null, uaString: s };
    }
    const s =
      "Mozilla/5.0 (Linux; Android 14; SM-X900) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
    return { uaObj: null, uaString: s };
  }
  // desktop fallback
  const s =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
  return { uaObj: null, uaString: s };
}

/* ------------------------------------------------------------------ *
 * Public types
 * ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ *
 * Exports
 * ------------------------------------------------------------------ */

export function pick2025UA() {
  const deviceCategory = pickWeighted(DEVICE_MIX);

  // MOBILE
  if (deviceCategory === "mobile") {
    const osName = pickWeighted(MOBILE_OS_MIX);

    if (osName === "iOS") {
      const { uaObj, uaString } = pickUAWithBackoff({
        deviceCategory,
        osName,
        browserName: "Safari",
      });
      const hw = pickHardware("mobile", "iOS");
      const browserName = uaObj?.data?.browserName || "Mobile Safari";
      const browserVersion = uaObj?.data?.browserVersion || "";
      return {
        uaString, deviceCategory, osName, browserName, browserVersion,
        viewport: hw.viewport, dpr: hw.dpr,
        hardwareConcurrency: hw.cores,
        deviceMemoryGB: hw.memoryGB,
        model: hw.model,
        vendor: "Apple",
        clientHints: null,
      };
    }

    // Android
    const vendor = pickWeighted(ANDROID_VENDOR_MIX);
    const modelHint =
      /Samsung/i.test(vendor)
        ? pickWeighted(ANDROID_SAMSUNG_MODELS.map(x => ({ key: x.model, w: x.w })))
        : pickWeighted(ANDROID_OTHER_MODELS.map(x => ({ key: x.model, w: x.w })));

    const { uaObj, uaString } = pickUAWithBackoff({
      deviceCategory,
      osName: "Android",
      browserName: "Chrome",
      vendorHint: vendor,
      modelToken: modelHint
    });

    const hw = pickHardware("mobile", "Android", modelHint);
    const { brand, brandFull, brandMajor, chromiumFull, chromiumMajor } = parseChromiumVersions(uaString);
    const browserName = uaObj?.data?.browserName || (brand === "Microsoft Edge" ? "Edge" : (brand || "Chrome"));
    const browserVersion = brandFull;

    const ch = {
      "Sec-CH-UA": chMajorList(brand, brandMajor, chromiumMajor),
      "Sec-CH-UA-Mobile": "?1",
      "Sec-CH-UA-Platform": `"${PLATFORM_LABEL.Android}"`,
      "Sec-CH-UA-Platform-Version": `"${chPlatformVersion("Android")}"`,
      "Sec-CH-UA-Full-Version": `"${browserVersion}"`,
      "Sec-CH-UA-Full-Version-List": chFullList(brand, brandFull, chromiumFull),
      "Sec-CH-UA-Model": `"${hw.model || ""}"`,
      "Sec-CH-UA-Arch": `"arm"`,
      "Sec-CH-UA-Bitness": `"64"`,
      "Sec-CH-UA-Form-Factors": `"Mobile"`,
    };

    return {
      uaString, deviceCategory, osName: "Android", browserName, browserVersion,
      viewport: hw.viewport, dpr: hw.dpr,
      hardwareConcurrency: hw.cores,
      deviceMemoryGB: hw.memoryGB,
      model: hw.model,
      vendor,
      clientHints: ch
    };
  }

  // TABLET
  if (deviceCategory === "tablet") {
    const bucket = pickWeighted(TABLET_BUCKETS);
    const picked = TABLET_BUCKETS.find(x => x.name === (bucket.name || bucket));

    if (picked.name === "iPad") {
      const { uaObj, uaString } = pickUAWithBackoff({
        deviceCategory,
        osName: "iOS",
        browserName: "Safari",
      });
      const hw = pickHardware("tablet", "iOS");
      const browserName = uaObj?.data?.browserName || "Mobile Safari";
      const browserVersion = uaObj?.data?.browserVersion || "";
      return {
        uaString, deviceCategory, osName: "iOS", browserName, browserVersion,
        viewport: hw.viewport, dpr: hw.dpr,
        hardwareConcurrency: hw.cores,
        deviceMemoryGB: hw.memoryGB,
        model: "iPad",
        vendor: "Apple",
        clientHints: null,
      };
    }

    const { uaObj, uaString } = pickUAWithBackoff({
      deviceCategory,
      osName: "Android",
      browserName: "Chrome",
    });
    const hw = pickHardware("tablet", "Android");

    const { brand, brandFull, brandMajor, chromiumFull, chromiumMajor } = parseChromiumVersions(uaString);
    const browserName = uaObj?.data?.browserName || (brand === "Microsoft Edge" ? "Edge" : (brand || "Chrome"));
    const browserVersion = brandFull;

    const ch = {
      "Sec-CH-UA": chMajorList(brand, brandMajor, chromiumMajor),
      "Sec-CH-UA-Mobile": "?1",
      "Sec-CH-UA-Platform": `"${PLATFORM_LABEL.Android}"`,
      "Sec-CH-UA-Platform-Version": `"${chPlatformVersion("Android")}"`,
      "Sec-CH-UA-Full-Version": `"${browserVersion}"`,
      "Sec-CH-UA-Full-Version-List": chFullList(brand, brandFull, chromiumFull),
      "Sec-CH-UA-Model": `""`,
      "Sec-CH-UA-Arch": `"arm"`,
      "Sec-CH-UA-Bitness": `"64"`,
      "Sec-CH-UA-Form-Factors": `"Mobile"`,
    };

    return {
      uaString, deviceCategory, osName: "Android", browserName, browserVersion,
      viewport: hw.viewport, dpr: hw.dpr,
      hardwareConcurrency: hw.cores,
      deviceMemoryGB: hw.memoryGB,
      model: "Android Tablet",
      vendor: "Various",
      clientHints: ch,
    };
  }

  // DESKTOP
  const osName = pickWeighted(DESKTOP_OS_MIX);
  const browserName = pickWeighted(DESKTOP_BROWSER_MIX[osName]);
  const { uaObj, uaString } = pickUAWithBackoff({
    deviceCategory: "desktop",
    osName,
    browserName
  });

  const hw = pickHardware("desktop", osName);

  /** @type {UAProfile} */
  const profile = {
    uaString,
    deviceCategory: "desktop",
    osName,
    browserName: uaObj?.data?.browserName || browserName,
    browserVersion: uaObj?.data?.browserVersion || "",
    viewport: hw.viewport,
    dpr: 1,
    hardwareConcurrency: hw.cores,
    deviceMemoryGB: hw.memoryGB,
    model: null,
    vendor: osName === "Windows" ? "PC" : osName === "macOS" ? "Mac" : "PC",
    clientHints: null,
  };

  if (isChromium(profile.browserName)) {
    const { brand, brandFull, brandMajor, chromiumFull, chromiumMajor } = parseChromiumVersions(uaString);
    const productName = brand;
    const arch = /Windows|Linux/.test(osName) ? `"x86"` : `"arm"`;
    const ch = {
      "Sec-CH-UA": chMajorList(productName, brandMajor, chromiumMajor),
      "Sec-CH-UA-Mobile": "?0",
      "Sec-CH-UA-Platform": `"${PLATFORM_LABEL[osName]}"`,
      "Sec-CH-UA-Platform-Version": `"${chPlatformVersion(osName)}"`,
      "Sec-CH-UA-Full-Version": `"${brandFull}"`,
      "Sec-CH-UA-Full-Version-List": chFullList(productName, brandFull, chromiumFull),
      "Sec-CH-UA-Model": `""`,
      "Sec-CH-UA-Arch": arch,
      "Sec-CH-UA-Bitness": `"64"`,
      "Sec-CH-UA-Form-Factors": `"Desktop"`,
    };
    profile.browserVersion = brandFull;
    profile.clientHints = ch;
  } else {
    profile.clientHints = null;
  }

  if (!uaObj) {
    const inferred = inferPlatformFromUA(uaString);
    profile.osName = (["Windows","macOS","Linux","Android","iOS"].includes(inferred) ? inferred : osName);
    if (!profile.browserName) {
      if (/Edg\//.test(uaString)) profile.browserName = "Edge";
      else if (/Chrome\//.test(uaString)) profile.browserName = "Chrome";
      else if (/Safari\//.test(uaString)) profile.browserName = "Safari";
      else if (/Firefox\//.test(uaString)) profile.browserName = "Firefox";
      else profile.browserName = "Chrome";
    }
  }

  return profile;
}

/**
 * Build consistent request headers for a UA profile.
 */
export function buildHeadersForUA(uaProfile, extras = {}) {
  const {
    uaString, clientHints, deviceMemoryGB, viewport,
  } = uaProfile;

  const h = {
    "User-Agent": uaString,
    "Viewport-Width": String(viewport?.width || 0),
    ...(clientHints || {}),
    ...extras
  };

  if (clientHints) {
    const bucket = deviceMemoryGB >= 8 ? 8 : deviceMemoryGB >= 4 ? 4 : deviceMemoryGB >= 2 ? 2 : 1;
    h["Device-Memory"] = bucket;
  }

  return h;
}

/** Prototype sugar: new UserAgent().random2025() */
UserAgent.prototype.random2025 = function () {
  return pick2025UA();
};

export default { pick2025UA, buildHeadersForUA };
