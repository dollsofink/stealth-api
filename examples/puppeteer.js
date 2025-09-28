import { Puppeteer } from "stealth-api";
import puppeteer from 'puppeteer-extra'

// Looks & feels like vanilla Puppeteer. Your existing page.* code works unchanged.
const bot = new Puppeteer({
  headless: false,
  userDataDir: ".profiles/default",
  stealth: true,
  channel: "chrome"
});

// Get all property names, including non-enumerable ones
const allProperties = Object.getOwnPropertyNames(Puppeteer.prototype)

// Log the properties
console.log(allProperties)
await bot.launch();
const page = bot.page
const browser = bot.browser

// Reuse your existing script as-is:
await page.goto("https://google.com", { waitUntil: "load" });
const title = await page.title();
console.log({ title });

// Or run your native script in a disposable page:
// await browser.usingPage(async (page) => {
//   await page.goto("https://news.ycombinator.com");
//   await page.screenshot({ path: "hn.png" });
// });

await browser.close();