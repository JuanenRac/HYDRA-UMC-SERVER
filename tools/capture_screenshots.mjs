#!/usr/bin/env node
/**
 * Takes the screenshots of the README: the Server Admin page in a real browser (headless Microsoft Edge) against a real HYDRA-UMC SERVER started on this
 * computer in a throw-away folder. The server has a made-up administrator, no robots and no real network behind it. Nothing real is behind the pictures.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 *
 *   npm run build                                   the SERVER built (dist/server.cjs); and npm ci in admin-ui/ (the admin page is built into the throw-away folder)
 *   node tools/capture_screenshots.mjs              writes images/screenshots/<name>.png at 1440x900
 *   node tools/capture_screenshots.mjs --out DIR    writes them in DIR instead, to look at them before they replace the ones in the repository
 *
 * It needs Edge (the one Windows has) and Playwright, which it takes from PLAYWRIGHT_DIR (a folder that has node_modules/@playwright/test) or from ./node_modules.
 * The server listens on port 3197 (HYDRA_UMC_SERVER_PORT): stop whatever uses it first. It takes no mouse or keyboard of the desktop: the browser has no
 * window. Everything it starts is stopped at the end and its folder is deleted.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const playwrightDir = process.env.PLAYWRIGHT_DIR ?? repo;
const require = createRequire(path.join(playwrightDir, "package.json"));
const { chromium } = require("@playwright/test");
const outIndex = process.argv.indexOf("--out");
const out = path.resolve(outIndex > 0 ? process.argv[outIndex + 1] : path.join(repo, "images", "screenshots"));
fs.mkdirSync(out, { recursive: true });

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const portFree = port => new Promise(resolve => { const probe = net.createServer(); probe.once("error", () => resolve(false)); probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true))); });
const work = fs.mkdtempSync(path.join(os.tmpdir(), "hydra-server-shots-"));
const children = [];
const password = crypto.randomBytes(18).toString("base64url");
const port = 3197;
if (!(await portFree(port))) throw new Error(`port ${port} must be free`);
let browser;
try {
  fs.mkdirSync(path.join(work, "data"));
  // The server serves ./public of its working folder: the admin page is built from its source straight into the throw-away folder, so the pictures show the
  // current page and the repository is left as it is.
  const adminDir = path.join(repo, "admin-ui");
  const built = spawnSync(process.execPath, [path.join(adminDir, "node_modules", "vite", "bin", "vite.js"), "build", "--outDir", path.join(work, "public", "admin"), "--emptyOutDir"], { cwd: adminDir, stdio: "ignore" });
  if (built.status !== 0) throw new Error("the admin page did not build (npm ci in admin-ui first)");
  children.push(spawn(process.execPath, [path.join(repo, "dist", "server.cjs")], {
    cwd: work,
    stdio: "ignore",
    env: {
      ...process.env,
      HYDRA_UMC_SERVER_PORT: String(port),
      JWT_SECRET: crypto.randomBytes(32).toString("hex"),
      HYDRA_UMC_BOOTSTRAP_ADMIN_USERNAME: "admin",
      HYDRA_UMC_BOOTSTRAP_ADMIN_PASSWORD: password,
    },
  }));
  const origin = `http://127.0.0.1:${port}`;
  for (let tries = 0; tries < 120; tries += 1) { try { await fetch(origin + "/admin/"); break; } catch { await sleep(250); } }

  browser = await chromium.launch({ channel: "msedge", headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, locale: "en-US" });
  const page = await context.newPage();
  await page.goto(origin + "/admin/");
  await page.locator("input[type=password]").waitFor({ timeout: 60000 });
  await page.locator("input").first().fill("admin");
  await page.locator("input[type=password]").fill(password);
  await page.locator("button[type=submit]").click();
  await page.locator("nav button, button").filter({ hasText: /devices/i }).first().waitFor({ timeout: 30000 });
  const shot = async (file, tab) => {
    if (tab) await page.locator("button").filter({ hasText: tab }).first().evaluate(element => element.click());
    await page.waitForTimeout(2500);
    await page.mouse.move(1430, 890);
    await page.screenshot({ path: path.join(out, file + ".png"), fullPage: true });
    console.log("wrote", path.join(out, file + ".png"));
  };
  // The Devices tab (nothing is connected here) and the Logs tab (it shows the date of the day) are not pictured.
  await shot("security", /security/i);
  await shot("users", /users/i);
  await shot("config", /^\s*config/i);
} finally {
  await browser?.close();
  for (const child of children) try { child.kill(); } catch { /* already gone */ }
  for (let tries = 0; tries < 10; tries += 1) {   // the server may still hold its folder for a moment after it is told to stop
    await sleep(500);
    try { fs.rmSync(work, { recursive: true, force: true }); break; } catch { /* try again */ }
  }
}
