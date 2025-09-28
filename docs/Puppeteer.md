# `stealth-api` — Puppeteer Class README

The `Puppeteer` class in **stealth-api** wraps vanilla Puppeteer with pragmatic “real-world” defaults and batteries-included options for:

- Headless/headful runs (with sensible args)
- Persistent user profiles (`userDataDir`) & cookie/session helpers
- **Weighted GEO-mapped proxy pools** (automatic rotation, per-request overrides)
- **Weighted device emulation** (desktop/tablet/mobile, custom UA/viewport)
- Resource blocking & network throttles
- Safer navigation/click/type retries with jitter
- A compact set of **helpers** you can use on any `page` (documented at the bottom)

If you already know Puppeteer, you can drop this in and keep using your normal `page.*` APIs—this class just handles the unglamorous parts (profiles, proxies, devices, retries).

---

## Install

```bash
npm i stealth-api puppeteer
# or
pnpm add stealth-api puppeteer
# or
yarn add stealth-api puppeteer
```

> `puppeteer` is a peer dependency. Use the version you prefer.

---

## Import / Basic Usage

ESM:

```js
import { Puppeteer } from "stealth-api";
import helpers from "stealth-api/puppeteer"; // helper functions (see bottom)
```

CommonJS:

```js
const { Puppeteer } = require("stealth-api");
const helpers = require("stealth-api/puppeteer").default;
```

Quick start:

```js
const bot = new Puppeteer({
  headless: true,             // or 'new' / false
  userDataDir: ".profiles/main",
  stealth: true,              // enable anti-automation evasions
  timeouts: { navigation: 45_000, action: 15_000 },
});

await bot.launch();
const page = await bot.newPage();

await page.goto("https://example.com", { waitUntil: "networkidle2" });
await helpers.clickIfVisible(page, "a.more");
await bot.close();
```

---

## Constructor Options

```ts
type ProxySpec = {
  url: string;                // e.g. "http://user:pass@host:port" or "socks5://host:port"
  country?: string;           // ISO-2 (for geo-weighting)
  label?: string;             // your own id
  weight?: number;            // default 1
};

type DeviceSpec = {
  name?: string;              // label for logs
  userAgent: string;
  viewport: {
    width: number; height: number;
    deviceScaleFactor?: number;
    isMobile?: boolean; hasTouch?: boolean; isLandscape?: boolean;
  };
  weight?: number;            // default 1 (for weighted selection)
};

interface PuppeteerLaunchOptions {
  headless?: boolean | "new";          // defaults true
  executablePath?: string;             // custom Chrome/Chromium
  userDataDir?: string;                // persistent profile
  args?: string[];                     // extra chromium args
  slowMo?: number;                     // ms throttle for human-ish actions
  sandbox?: boolean;                   // add/remove --no-sandbox
  locale?: string;                     // e.g. "en-US"
  userAgent?: string;                  // override UA (if not using device)
  viewport?: DeviceSpec["viewport"];   // override viewport (if not using device)

  // Proxies
  proxy?: string | ProxySpec | ProxySpec[];   // single or pool
  proxyStrategy?: "first" | "roundrobin" | "weighted" | "geo-weighted";
  preferCountries?: string[];                 // e.g. ["US","CA","GB"]

  // Device emulation
  device?: "desktop" | "mobile" | "tablet" | DeviceSpec; // single device
  devices?: (DeviceSpec | "desktop" | "mobile" | "tablet")[]; // pool
  deviceStrategy?: "first" | "roundrobin" | "weighted";

  // Networking
  blockResources?: Array<"image"|"media"|"font"|"stylesheet"|"xhr"|"fetch"|"websocket">;
  throttle?: { download?: number; upload?: number; latency?: number };

  // Security / auth
  httpCredentials?: { username: string; password: string }; // site Basic Auth
  ignoreHTTPSErrors?: boolean;

  // Timeouts & retries
  timeouts?: { navigation?: number; action?: number };
  retries?:   { nav?: number; click?: number; type?: number };

  // Downloads & temp
  downloadDir?: string;

  // Behavior
  stealth?: boolean; // enable evasions
  logger?: (...args: any[]) => void;  // custom logger
}
```

---

## API Surface

```ts
class Puppeteer {
  constructor(opts?: PuppeteerLaunchOptions)

  launch(): Promise<{ browser: import("puppeteer").Browser }>
  close(): Promise<void>

  /** Returns the active Browser instance (after launch). */
  getBrowser(): import("puppeteer").Browser | null

  /** Create a new Page using the current device+proxy selection rules. */
  newPage(opts?: {
    proxy?: string | ProxySpec;     // override for this page
    device?: DeviceSpec | "desktop" | "mobile" | "tablet"; // override
    blockResources?: PuppeteerLaunchOptions["blockResources"];
  }): Promise<import("puppeteer").Page>

  /** Run a function with a temporary page (auto-close on success/fail). */
  usingPage<T>(fn: (page: import("puppeteer").Page) => Promise<T>, perPageOpts?: Parameters<Puppeteer["newPage"]>[0]): Promise<T>

  /** Cookie utilities (when using persistent profiles). */
  saveCookies(filePath: string, page?: import("puppeteer").Page): Promise<void>
  loadCookies(filePath: string, page?: import("puppeteer").Page): Promise<void>

  /** Rotate the next page’s proxy/device selection explicitly. */
  rotateProxy(): void
  rotateDevice(): void
}
```

> Methods like `saveCookies` and `loadCookies` are convenience wrappers around the helpers at the bottom.

---

## Examples

### 1) Headless vs. Headful (visible browser)

```js
const bot = new Puppeteer({
  headless: false, // show the window
  userDataDir: ".profiles/work", // keep sessions
  args: ["--window-size=1280,800"],
});
await bot.launch();

const page = await bot.newPage();
await page.goto("https://news.ycombinator.com");
await bot.close();
```

### 2) Persistent Profile with Cookie Save/Load

```js
const bot = new Puppeteer({ userDataDir: ".profiles/hacker" });
await bot.launch();

const page = await bot.newPage();
await page.goto("https://example.com/login");

// ... perform login once

await bot.saveCookies(".profiles/hacker/cookies.json", page);
// later…
await bot.loadCookies(".profiles/hacker/cookies.json", page);
```

### 3) Single Proxy (with auth)

```js
const bot = new Puppeteer({
  proxy: "http://user:pass@proxy.myhost:3128",
  headless: "new",
});
await bot.launch();

const page = await bot.newPage();
await page.goto("https://ipinfo.io/json");
console.log(await page.content());
await bot.close();
```

### 4) **Weighted GEO-Mapped Proxy Pool**

Pick proxies from a pool with weights and country preferences.

```js
const proxies = [
  { url: "http://us1:pass@1.2.3.4:8000", country: "US", weight: 6, label: "US-A" },
  { url: "http://us2:pass@1.2.3.5:8000", country: "US", weight: 4, label: "US-B" },
  { url: "http://de1:pass@5.6.7.8:8000", country: "DE", weight: 2, label: "DE-A" },
  { url: "http://br1:pass@9.9.9.9:8000", country: "BR", weight: 1, label: "BR-A" },
];

const bot = new Puppeteer({
  proxy: proxies,
  proxyStrategy: "geo-weighted", // uses preferCountries + weight
  preferCountries: ["US", "CA", "GB"], // falls back if none available
  logger: console.log,
});

await bot.launch();

// Page #1 likely US
const p1 = await bot.newPage();
await p1.goto("https://whatismyipaddress.com/");

// Force a rotation for next page
bot.rotateProxy();

// Page #2 will pick the next proxy according to strategy
const p2 = await bot.newPage();
await p2.goto("https://ipinfo.io/");
```

Per-page override:

```js
const page = await bot.newPage({
  proxy: { url: "http://de1:pass@5.6.7.8:8000", country: "DE" },
});
```

### 5) **Weighted Device Emulation**

Use built-ins (`desktop|mobile|tablet`) or fully custom `DeviceSpec`.

```js
const devices = [
  { name: "iPhone 13", weight: 5,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) ...",
    viewport: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true }
  },
  { name: "Pixel 7", weight: 3,
    userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 7) ...",
    viewport: { width: 412, height: 915, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true }
  },
  { name: "Desktop 1440p", weight: 2,
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ...",
    viewport: { width: 1920, height: 1080, deviceScaleFactor: 1 }
  }
];

const bot = new Puppeteer({
  devices,
  deviceStrategy: "weighted",
});

await bot.launch();

const page = await bot.newPage();
await page.goto("https://www.wikipedia.org");
```

Per-page device override:

```js
const mobilePage = await bot.newPage({ device: "mobile" });
```

### 6) Resource Blocking & Throttle

```js
const bot = new Puppeteer({
  blockResources: ["image", "font", "media"],
  throttle: { download: 500 * 1024, upload: 64 * 1024, latency: 200 }, // ~512kbps
});
await bot.launch();

const page = await bot.newPage();
await page.goto("https://text-heavy-site.example", { waitUntil: "domcontentloaded" });
```

### 7) Safer Navigation + Actions with Retries

```js
const bot = new Puppeteer({
  retries: { nav: 2, click: 3, type: 2 },
  timeouts: { navigation: 60_000, action: 12_000 },
  slowMo: 25, // adds human-ish delay
});
await bot.launch();

await bot.usingPage(async (page) => {
  await page.goto("https://example.com");
  await helpers.clickIfVisible(page, "#accept-cookies");
  await helpers.typeHuman(page, "#search", "weighted device emulation");
  await helpers.clickIfVisible(page, 'button[type="submit"]');
});
```

### 8) Basic Auth (site) + Ignore HTTPS Errors

```js
const bot = new Puppeteer({
  httpCredentials: { username: "admin", password: "secret" },
  ignoreHTTPSErrors: true,
});
await bot.launch();
const page = await bot.newPage();
await page.goto("https://self-signed-internal.example");
```

### 9) Concurrency: Multiple Pages per Single Browser

```js
const bot = new Puppeteer({ headless: true, userDataDir: ".profiles/multipage" });
await bot.launch();

const tasks = [
  "https://example.com",
  "https://developer.mozilla.org",
  "https://npmjs.com",
].map(url => bot.usingPage(page => page.goto(url, { waitUntil: "networkidle2" })));

await Promise.all(tasks);
await bot.close();
```

### 10) Custom Chrome & Downloads

```js
const bot = new Puppeteer({
  executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  downloadDir: "./downloads",
});
await bot.launch();
const page = await bot.newPage();
// ... trigger a file download (helpers.waitForDownload available)
```

---

## Tips & Notes

- **Profiles**: `userDataDir` makes sessions sticky (good for keeping logins). Use a different folder per persona.
- **Headless**: Recent Chrome supports `"new"` headless; some sites behave differently—toggle if you see issues.
- **Proxies**: If your proxy requires auth and you _also_ pass credentials in the URL, the URL wins.
- **Stealth**: `stealth: true` enables a curated set of evasions; you can still add your own `page.evaluateOnNewDocument` logic.

---

## Helpers (imported from `stealth-api/puppeteer`)

Import:

```js
import helpers from "stealth-api/puppeteer";
// or: const helpers = require("stealth-api/puppeteer").default;
```

### `applyProfileToPage(page, profile)`

Apply a full device+locale+ua+viewport “profile” to an existing page.

```js
await helpers.applyProfileToPage(page, {
  userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) ...",
  locale: "en-US",
  viewport: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
});
```

### `clickIfVisible(page, selector, opts?)`

Clicks only when the target is **present and visible** (size > 0, not `display:none`, not `visibility:hidden`) and scrolled into view.  
Useful to close popups, accept cookies, etc.

```js
await helpers.clickIfVisible(page, "#accept", { timeout: 4000, scroll: true });
```

**Options** (all optional):
```ts
{
  timeout?: number;           // ms waiting for visibility
  scroll?: boolean;           // scroll into view if needed (default true)
  delay?: number;             // ms delay before click (human-ish)
}
```

### `typeHuman(page, selector, text, opts?)`

Types with jitter (randomized per-char delay). Good enough to bypass fragile “bots type too fast” heuristics.

```js
await helpers.typeHuman(page, "input[name=q]", "hello world", {
  baseDelay: 60,  // per keystroke baseline
  jitter: 40,     // +/- ms
  clear: true,    // select+clear existing text first
});
```

### `sleep(ms)`

Simple pause:

```js
await helpers.sleep(500);
```

### `waitForSelectors(page, selectors, opts?)`

Wait until **any** selector in the list becomes visible.

```js
const el = await helpers.waitForSelectors(
  page,
  ["#main", ".content", "section[data-role=app]"],
  { timeout: 10_000 }
);
```

### `waitForResourcesIdle(page, {idleTime, timeout})`

Resolve when the network stays quiet for `idleTime` (ms), up to `timeout`.

```js
await helpers.waitForResourcesIdle(page, { idleTime: 1200, timeout: 15_000 });
```

### `autoScrollToBottom(page, {step, delay, maxScrolls})`

Smoothly scrolls to bottom, yielding to the event loop.

```js
await helpers.autoScrollToBottom(page, { step: 600, delay: 100, maxScrolls: 50 });
```

### `saveCookies(page, filePath)` / `loadCookies(page, filePath)`

Persist cookies for reuse across runs.

```js
await helpers.saveCookies(page, ".profiles/main/cookies.json");
// later…
await helpers.loadCookies(page, ".profiles/main/cookies.json");
```

### `uploadFile(page, selector, filePath)`

Sets a file on an `<input type="file">` element.

```js
await helpers.uploadFile(page, 'input[type="file"]', "./assets/video.mp4");
```

### `selectByLabel(page, selector, label)`

Choose an option by its visible label, not just `value`.

```js
await helpers.selectByLabel(page, "select#country", "United States");
```

### `interceptAndBlock(page, patterns)`

Block matching requests by glob/regex.

```js
await helpers.interceptAndBlock(page, [
  /google-analytics\.com/,
  "**/*.png",
  "**/*.woff2",
]);
```

### `waitForDownload(page, {dir, timeout})`

Waits for a new file to appear in the downloads directory.

```js
const filePath = await helpers.waitForDownload(page, { dir: "./downloads", timeout: 60_000 });
console.log("Downloaded:", filePath);
```

---

## Example Putting Helpers Together

```js
import { Puppeteer } from "stealth-api";
import helpers from "stealth-api/puppeteer";

const bot = new Puppeteer({
  userDataDir: ".profiles/shopper",
  devices: ["desktop", "mobile"],
  deviceStrategy: "weighted",
  proxy: [
    { url: "http://us:pass@1.2.3.4:8000", country: "US", weight: 5 },
    { url: "http://de:pass@5.6.7.8:8000", country: "DE", weight: 2 },
  ],
  proxyStrategy: "geo-weighted",
  preferCountries: ["US"],
  blockResources: ["font", "image"],
  stealth: true,
});

await bot.launch();

await bot.usingPage(async (page) => {
  await page.goto("https://example-shop.com");
  await helpers.clickIfVisible(page, "button#accept-cookies");
  await helpers.typeHuman(page, "input#search", "wireless earbuds");
  await helpers.clickIfVisible(page, "form#search button[type=submit]");
  await helpers.waitForResourcesIdle(page, { idleTime: 1000, timeout: 10000 });
  await helpers.autoScrollToBottom(page, { step: 800, delay: 50, maxScrolls: 30 });
});

await bot.close();
```

---

## Troubleshooting

- **Blank pages in headless**: try `headless: false` or `headless: "new"` and compare. Some sites gate legacy headless.
- **Proxies not applied**: ensure your proxy URL scheme matches your server (`http://` vs `socks5://`). If both URL creds and `page.authenticate` are used, the URL creds usually win.
- **Stuck waiting for network idle**: dynamic sites never fully “idle.” Prefer `waitForResourcesIdle` with a small `idleTime`.
- **“Element not visible”**: use `clickIfVisible`/`waitForSelectors` and consider `scroll: true` options.

---

## License

MIT (see repository root).

---

If you need an example that isn’t covered here, throw your target site flow at the wall—I’ll sketch a working snippet using the class + helpers combo.
