import { Puppeteer } from "stealth-api";

// Looks & feels like vanilla Puppeteer. Your existing page.* code works unchanged.
const browser = new Puppeteer({
  headless: "new",
  userDataDir: ".profiles/default",
  stealth: true
});

await browser.launch();

// Reuse your existing script as-is:
const page = await browser.newPage();
await page.goto("https://example.com", { waitUntil: "networkidle2" });
const title = await page.title();
console.log({ title });

// Or run your native script in a disposable page:
await browser.usingPage(async (page) => {
  await page.goto("https://news.ycombinator.com");
  await page.screenshot({ path: "hn.png" });
});

await browser.close();