import { mkdir } from 'node:fs/promises';
import { loadConfig } from './config.mjs';

const config = loadConfig();
await mkdir(config.profileDir, { recursive: true });

const { chromium } = await import('playwright');
const context = await chromium.launchPersistentContext(config.profileDir, {
  headless: false,
  viewport: { width: 1365, height: 900 },
  locale: 'he-IL',
  timezoneId: 'Asia/Jerusalem',
});
const page = context.pages()[0] || await context.newPage();
await page.goto(config.groupUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
console.log('Use the temporary VNC session to log in to Facebook and open the Chiping group.');
console.log('The browser profile is saved automatically. This login process closes after 20 minutes.');
await new Promise((resolve) => setTimeout(resolve, 20 * 60 * 1000));
await context.close();
