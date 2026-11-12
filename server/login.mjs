#!/usr/bin/env node
// node login.mjs <login> [--email <expected>] [--minutes <n>]
// Opens a HEADED Chromium with a persistent profile (<FACTORY_DIR>/logins/<login>/profile). YOU log in
// to Zapier — this script never fills credentials. When /api/v4/session in that page says you are logged
// in (as --email, if given), it saves the cookies to <loginDir>/session.json and meta.json and exits.
// Cookie values are never printed.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { loginDir } from './lib.mjs';

const USAGE = 'usage: node login.mjs <login> [--email <expected>] [--minutes <n>]   (login: lowercase letters, digits, dashes)';
const argv = process.argv.slice(2);
const login = argv[0] && !argv[0].startsWith('--') ? argv[0] : null;
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
if (!login) { console.error(USAGE); process.exit(1); }
const EXPECTED_EMAIL = opt('--email');
const minutes = opt('--minutes') === undefined ? 30 : Number(opt('--minutes'));
if (!(minutes > 0)) { console.error('--minutes must be a positive number. ' + USAGE); process.exit(1); }
let DIR;
try { DIR = loginDir(login); } catch (e) { console.error(e.message + '. ' + USAGE); process.exit(1); }

const PROFILE_DIR = path.join(DIR, 'profile');
const SESSION_FILE = path.join(DIR, 'session.json');
const META_FILE = path.join(DIR, 'meta.json');
const START_URL = 'https://zapier.com/app/assets/zaps';
const TIMEOUT_MS = minutes * 60 * 1000;

// Use Playwright's own Chromium if present; otherwise the newest chromium-* build in ms-playwright.
function findChromium() {
  try { const p = chromium.executablePath(); if (p && fs.existsSync(p)) return undefined; } catch {}
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  let dirs = [];
  try { dirs = fs.readdirSync(root).filter(d => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1])); } catch {}
  for (const d of dirs) for (const sub of ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe', 'chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
    const p = path.join(root, d, sub);
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`No Chromium found. Run: npx playwright@1.63.0 install chromium`);
}

fs.mkdirSync(PROFILE_DIR, { recursive: true });
const executablePath = findChromium();
console.log(`Opening Chromium${executablePath ? ' (' + executablePath + ')' : ''} with profile ${PROFILE_DIR}`);
const ctx = await chromium.launchPersistentContext(PROFILE_DIR, { headless: false, executablePath, viewport: null });
const page = ctx.pages()[0] || await ctx.newPage();
await page.goto(START_URL).catch(() => {});
console.log(`Log in to Zapier${EXPECTED_EMAIL ? ' as ' + EXPECTED_EMAIL : ''} in the browser window (you type the password). Waiting up to ${minutes} minutes...`);

const deadline = Date.now() + TIMEOUT_MS;
let warned = '';
let ok = null;
while (Date.now() < deadline) {
  if (page.isClosed()) { console.error('Browser window was closed before login finished.'); process.exit(1); }
  const s = await page.evaluate(async () => {
    if (location.origin !== 'https://zapier.com') return null;
    try { const r = await fetch('/api/v4/session', { credentials: 'include' }); return r.ok ? await r.json() : null; } catch { return null; }
  }).catch(() => null);
  if (s?.is_logged_in && (!EXPECTED_EMAIL || s.email === EXPECTED_EMAIL)) { ok = s; break; }
  if (EXPECTED_EMAIL && s?.is_logged_in && s.email !== EXPECTED_EMAIL && warned !== s.email) {
    warned = s.email;
    console.warn(`Logged in as ${s.email}, not ${EXPECTED_EMAIL}. Log out and log in as ${EXPECTED_EMAIL}; still waiting...`);
  }
  await page.waitForTimeout(3000).catch(() => {});
}
if (!ok) { console.error(`Timed out after ${minutes} minutes without a matching login. Nothing saved.`); await ctx.close(); process.exit(1); }

fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
await ctx.storageState({ path: SESSION_FILE });
const userAgent = await page.evaluate(() => navigator.userAgent).catch(() => undefined);
fs.writeFileSync(META_FILE, JSON.stringify({ email: ok.email, account_id: ok.current_account_id, userAgent, savedAt: new Date().toISOString() }, null, 2));
const n = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')).cookies.length;
console.log(`Saved session for ${ok.email} (login ${login}): ${n} cookies -> ${SESSION_FILE}. Cookie values are not printed.`);
console.log(`current_account_id: ${ok.current_account_id}`);
try {
  const accts = await page.evaluate(async () => {
    try { const r = await fetch('/api/v4/accounts?limit=9999', { credentials: 'include' }); return r.ok ? await r.json() : null; } catch { return null; }
  });
  const list = accts?.objects || accts?.results || accts?.accounts || (Array.isArray(accts) ? accts : null);
  console.log('accounts: ' + (list ? JSON.stringify(list.map(a => ({ id: a.id, name: a.name ?? a.title })), null, 2) : 'could not be read from /api/v4/accounts?limit=9999'));
} catch (e) { console.log('accounts: could not be read (' + e.message + ')'); }
await ctx.close();
process.exit(0);
