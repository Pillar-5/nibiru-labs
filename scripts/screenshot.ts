/**
 * Capture screenshots from the running dashboard for documentation.
 *
 * Starts nothing itself: run `npm run api` and `npm run web:dev` (or
 * `npm run web:build && npm run web:preview`) first, then:
 *
 *   npm run screenshots
 *
 * It drives a local Chromium-based browser (Microsoft Edge / Chrome) in
 * headless mode over the DevTools protocol via puppeteer-core, so no browser
 * binary is downloaded. Override the browser with CHROME_PATH if needed.
 * Output is written to screenshots/ as PNG files taken from the live UI.
 */
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const outDir = resolve(root, "screenshots");

const BASE_URL = process.env.DASHBOARD_URL ?? "http://localhost:5173/";

function findBrowser(): string {
  const env = process.env.CHROME_PATH?.trim();
  if (env && existsSync(env)) return env;
  const candidates = [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ];
  const hit = candidates.find((p) => existsSync(p));
  if (!hit) throw new Error("No Edge/Chrome found. Set CHROME_PATH to your browser executable.");
  return hit;
}

async function main(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: findBrowser(),
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--hide-scrollbars"],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1120, height: 1200, deviceScaleFactor: 2 });
    await page.goto(BASE_URL, { waitUntil: "networkidle0", timeout: 30000 });

    // Wait for real data to render (the report table header appears once the
    // API returns a snapshot). Fail loudly if the app is not serving data.
    await page.waitForFunction(
      () => document.body?.innerText.includes("Latest integrity report"),
      { timeout: 20000 },
    );
    await new Promise((r) => setTimeout(r, 800)); // let the chart paint

    await page.screenshot({ path: resolve(outDir, "dashboard.png"), fullPage: true });
    console.log("wrote screenshots/dashboard.png");

    // Select a pair with a populated deviation series, then screenshot again.
    const clicked = await page.evaluate(() => {
      const buttons = [...document.querySelectorAll("button")];
      const target = buttons.find((b) => b.textContent === "ubtc:uusd");
      if (target) target.click();
      return !!target;
    });
    await new Promise((r) => setTimeout(r, 800));
    if (clicked) {
      await page.screenshot({ path: resolve(outDir, "dashboard-deviation-history.png"), fullPage: true });
      console.log("wrote screenshots/dashboard-deviation-history.png");
    }
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
