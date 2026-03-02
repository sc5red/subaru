import puppeteer from 'puppeteer';
import logger from '../utils/logger.js';
import { truncate } from '../utils/format.js';

/**
 * Persistent browser session manager.
 * Keeps a browser instance alive across tool calls so the agent can
 * navigate, interact, log in, and perform multi-step workflows.
 */

let browser = null;
let activePage = null;
const pages = new Map(); // tabId -> page

async function getBrowser(headless = true) {
  if (browser && browser.connected) return browser;
  logger.info(`Launching browser (headless=${headless})...`);
  browser = await puppeteer.launch({
    headless: headless ? 'new' : false,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--window-size=1280,900'
    ],
    defaultViewport: { width: 1280, height: 900 }
  });
  browser.on('disconnected', () => {
    browser = null;
    activePage = null;
    pages.clear();
    logger.info('Browser disconnected.');
  });
  return browser;
}

async function getPage(tabId) {
  if (tabId && pages.has(tabId)) {
    const p = pages.get(tabId);
    try { await p.title(); return p; } catch { pages.delete(tabId); }
  }
  if (activePage) {
    try { await activePage.title(); return activePage; } catch { activePage = null; }
  }
  const b = await getBrowser();
  const allPages = await b.pages();
  activePage = allPages.length > 0 ? allPages[0] : await b.newPage();
  return activePage;
}

/**
 * Extract readable text content from a page, trimmed to a sensible length.
 */
async function extractText(page, maxLen = 4000) {
  const text = await page.evaluate(() => {
    // Remove script/style elements
    const clone = document.cloneNode(true);
    clone.querySelectorAll('script, style, noscript, svg, iframe').forEach(el => el.remove());
    return clone.body?.innerText || document.title || '';
  });
  return truncate(text.replace(/\n{3,}/g, '\n\n').trim(), maxLen);
}

/**
 * Get a structured snapshot of interactive elements on the page.
 */
async function getInteractiveElements(page, maxElements = 60) {
  return page.evaluate((max) => {
    const els = [];
    const selectors = 'a[href], button, input, textarea, select, [role="button"], [onclick], [tabindex]';
    const nodes = document.querySelectorAll(selectors);
    for (let i = 0; i < Math.min(nodes.length, max); i++) {
      const el = nodes[i];
      const tag = el.tagName.toLowerCase();
      const type = el.getAttribute('type') || '';
      const text = (el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || '').trim().substring(0, 80);
      const href = el.getAttribute('href') || '';
      const name = el.getAttribute('name') || '';
      const id = el.getAttribute('id') || '';
      els.push({ index: i, tag, type, text, href: href.substring(0, 120), name, id });
    }
    return els;
  }, maxElements);
}

const tools = [
  {
    name: 'browser_navigate',
    description: 'Navigate to a URL in the browser. Opens the page and returns the page title, URL, and a text summary of the visible content. Use this to visit websites, search engines, web apps, etc.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to navigate to (e.g., "https://google.com")' },
        waitFor: { type: 'string', description: 'Optional CSS selector to wait for before extracting content' },
        headless: { type: 'boolean', description: 'Run in headless mode (default: true). Set false to see the browser window.' }
      },
      required: ['url']
    },
    async execute(input, context) {
      try {
        if (input.headless === false) await getBrowser(false);
        const page = await getPage();
        activePage = page;

        logger.debug(`Browser navigating to: ${input.url}`);
        await page.goto(input.url, { waitUntil: 'networkidle2', timeout: 30000 });

        if (input.waitFor) {
          await page.waitForSelector(input.waitFor, { timeout: 10000 }).catch(() => {});
        }

        const title = await page.title();
        const url = page.url();
        const text = await extractText(page, 3000);
        const elements = await getInteractiveElements(page, 30);

        // Build a readable text summary instead of nested JSON to avoid LLM parser issues
        const elementsList = elements.slice(0, 15).map((el, i) =>
          `  [${el.index}] <${el.tag}${el.type ? ' type=' + el.type : ''}> ${el.text || el.href || el.name || el.id || '(no label)'}`
        ).join('\n');

        const output = [
          `Title: ${title}`,
          `URL: ${url}`,
          `Interactive elements: ${elements.length}`,
          '',
          '--- Page Content ---',
          text,
          '',
          '--- Interactive Elements (first 15) ---',
          elementsList
        ].join('\n');

        return { success: true, output };
      } catch (err) {
        return { success: false, output: '', error: err.message };
      }
    }
  },

  {
    name: 'browser_click',
    description: 'Click on an element on the current page. You can target by CSS selector, text content, or element index from a previous browser_navigate/browser_read call. After clicking, returns the updated page state.',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector of the element to click (e.g., "#login-btn", "a.nav-link")' },
        text: { type: 'string', description: 'Click the first element containing this text (alternative to selector)' },
        index: { type: 'number', description: 'Click the interactive element at this index from a previous element listing' },
        waitAfter: { type: 'number', description: 'Milliseconds to wait after clicking for page to update (default: 2000)' }
      }
    },
    async execute(input, context) {
      try {
        const page = await getPage();
        const waitAfter = input.waitAfter || 2000;

        if (input.selector) {
          await page.waitForSelector(input.selector, { timeout: 5000 });
          await page.click(input.selector);
        } else if (input.text) {
          // Find element by text content
          const clicked = await page.evaluate((searchText) => {
            const all = document.querySelectorAll('a, button, input[type="submit"], [role="button"], [onclick]');
            for (const el of all) {
              if (el.innerText?.trim().toLowerCase().includes(searchText.toLowerCase())) {
                el.click();
                return true;
              }
            }
            return false;
          }, input.text);
          if (!clicked) {
            return { success: false, output: '', error: `No clickable element found with text: "${input.text}"` };
          }
        } else if (input.index !== undefined) {
          const clicked = await page.evaluate((idx) => {
            const selectors = 'a[href], button, input, textarea, select, [role="button"], [onclick], [tabindex]';
            const nodes = document.querySelectorAll(selectors);
            if (idx < nodes.length) { nodes[idx].click(); return true; }
            return false;
          }, input.index);
          if (!clicked) {
            return { success: false, output: '', error: `No element at index ${input.index}` };
          }
        } else {
          return { success: false, output: '', error: 'Provide selector, text, or index to click.' };
        }

        // Wait for navigation or dynamic update
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: waitAfter }).catch(() => {});
        await new Promise(r => setTimeout(r, Math.min(waitAfter, 1000)));

        const title = await page.title();
        const url = page.url();
        const text = await extractText(page, 4000);

        return {
          success: true,
          output: JSON.stringify({ title, url, content: text }, null, 2)
        };
      } catch (err) {
        return { success: false, output: '', error: err.message };
      }
    }
  },

  {
    name: 'browser_type',
    description: 'Type text into an input field on the current page. Useful for filling forms, search boxes, login fields, etc. Can also press special keys like Enter, Tab, Escape.',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector of the input field (e.g., "input[name=username]", "#search-box")' },
        text: { type: 'string', description: 'The text to type into the field' },
        clearFirst: { type: 'boolean', description: 'Clear the field before typing (default: true)' },
        pressEnter: { type: 'boolean', description: 'Press Enter after typing (default: false)' },
        pressKey: { type: 'string', description: 'Press a special key after typing (e.g., "Enter", "Tab", "Escape")' }
      },
      required: ['selector', 'text']
    },
    async execute(input, context) {
      try {
        const page = await getPage();
        const { selector, text, clearFirst = true, pressEnter = false, pressKey } = input;

        await page.waitForSelector(selector, { timeout: 5000 });

        if (clearFirst) {
          await page.click(selector, { clickCount: 3 }); // Select all
          await page.keyboard.press('Backspace');
        }

        await page.type(selector, text, { delay: 30 });

        if (pressEnter || pressKey === 'Enter') {
          await page.keyboard.press('Enter');
          await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 5000 }).catch(() => {});
        } else if (pressKey) {
          await page.keyboard.press(pressKey);
        }

        await new Promise(r => setTimeout(r, 500));

        const title = await page.title();
        const url = page.url();

        return {
          success: true,
          output: JSON.stringify({ title, url, message: `Typed "${truncate(text, 50)}" into ${selector}` }, null, 2)
        };
      } catch (err) {
        return { success: false, output: '', error: err.message };
      }
    }
  },

  {
    name: 'browser_read',
    description: 'Read the current page content, interactive elements, or extract specific data. Use this to see what is on the page after navigating or performing actions.',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'Optional CSS selector to read content from a specific section only' },
        extractLinks: { type: 'boolean', description: 'Extract all links on the page (default: false)' },
        extractForms: { type: 'boolean', description: 'Extract all form fields on the page (default: false)' },
        listElements: { type: 'boolean', description: 'List interactive elements with indices for clicking (default: false)' },
        maxLength: { type: 'number', description: 'Max content length to return (default: 8000)' }
      }
    },
    async execute(input, context) {
      try {
        const page = await getPage();
        const title = await page.title();
        const url = page.url();
        const parts = [`Title: ${title}`, `URL: ${url}`, ''];

        if (input.selector) {
          const sectionText = await page.evaluate((sel) => {
            const el = document.querySelector(sel);
            return el ? el.innerText?.trim() : null;
          }, input.selector);
          parts.push('--- Section Content ---');
          parts.push(sectionText || `No element found for: ${input.selector}`);
        } else {
          parts.push('--- Page Content ---');
          parts.push(await extractText(page, input.maxLength || 4000));
        }

        if (input.extractLinks) {
          const links = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('a[href]')).slice(0, 30).map(a => ({
              text: a.innerText?.trim().substring(0, 60),
              href: a.href
            }));
          });
          parts.push('', '--- Links ---');
          links.forEach(l => parts.push(`  ${l.text} -> ${l.href}`));
        }

        if (input.extractForms) {
          const forms = await page.evaluate(() => {
            const forms = [];
            document.querySelectorAll('form').forEach((form, fi) => {
              const fields = [];
              form.querySelectorAll('input, textarea, select').forEach(el => {
                fields.push({
                  tag: el.tagName.toLowerCase(),
                  type: el.type || '',
                  name: el.name || '',
                  id: el.id || '',
                  placeholder: el.placeholder || ''
                });
              });
              forms.push({ index: fi, action: form.action || '', method: form.method || '', fields });
            });
            return forms;
          });
          parts.push('', '--- Forms ---');
          forms.forEach(f => {
            parts.push(`  Form ${f.index}: ${f.method.toUpperCase()} ${f.action}`);
            f.fields.forEach(fl => parts.push(`    <${fl.tag} type=${fl.type} name=${fl.name} id=${fl.id} placeholder="${fl.placeholder}">`));
          });
        }

        if (input.listElements) {
          const elements = await getInteractiveElements(page);
          parts.push('', '--- Interactive Elements ---');
          elements.forEach(el => {
            parts.push(`  [${el.index}] <${el.tag}${el.type ? ' type=' + el.type : ''}> ${el.text || el.href || el.name || el.id || '(no label)'}`);
          });
        }

        return { success: true, output: parts.join('\n') };
      } catch (err) {
        return { success: false, output: '', error: err.message };
      }
    }
  },

  {
    name: 'browser_screenshot',
    description: 'Take a screenshot of the current page or a specific element. Saves to a file and returns the file path. After taking a screenshot, use the display_image tool to send it to the user so they can see it.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to save the screenshot (default: auto-generated in data/)' },
        selector: { type: 'string', description: 'Optional CSS selector to screenshot a specific element only' },
        fullPage: { type: 'boolean', description: 'Capture the full scrollable page (default: false)' }
      }
    },
    async execute(input, context) {
      try {
        const page = await getPage();
        const fs = await import('node:fs');
        const path = await import('node:path');
        const { fileURLToPath } = await import('node:url');

        const __dirname = path.dirname(fileURLToPath(import.meta.url));
        const projectRoot = path.resolve(__dirname, '..', '..');
        const screenshotDir = path.join(projectRoot, 'data', 'screenshots');

        if (!fs.existsSync(screenshotDir)) {
          fs.mkdirSync(screenshotDir, { recursive: true });
        }

        const filePath = input.path || path.join(screenshotDir, `screenshot_${Date.now()}.png`);

        if (input.selector) {
          const el = await page.waitForSelector(input.selector, { timeout: 5000 });
          await el.screenshot({ path: filePath });
        } else {
          await page.screenshot({ path: filePath, fullPage: input.fullPage || false });
        }

        return {
          success: true,
          output: JSON.stringify({
            message: 'Screenshot saved',
            path: filePath,
            page: { title: await page.title(), url: page.url() }
          }, null, 2)
        };
      } catch (err) {
        return { success: false, output: '', error: err.message };
      }
    }
  },

  {
    name: 'browser_script',
    description: 'Execute JavaScript code directly in the browser page context. Use for advanced DOM manipulation, extracting structured data, interacting with web app APIs, automating complex UI workflows, etc.',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'JavaScript code to execute in the browser page context. Has access to document, window, fetch, etc. Return a value to get it back.' }
      },
      required: ['code']
    },
    async execute(input, context) {
      try {
        const page = await getPage();
        const result = await page.evaluate(input.code);
        const output = result !== undefined ? (typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result)) : '(no return value)';
        return { success: true, output };
      } catch (err) {
        return { success: false, output: '', error: err.message };
      }
    }
  },

  {
    name: 'browser_wait',
    description: 'Wait for a specific condition on the page — a selector to appear, text to be present, navigation to complete, or a fixed delay. Use between actions when pages need time to load.',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'Wait for this CSS selector to appear in the DOM' },
        text: { type: 'string', description: 'Wait for this text to appear on the page' },
        delay: { type: 'number', description: 'Wait for a fixed number of milliseconds' },
        navigation: { type: 'boolean', description: 'Wait for the next page navigation to complete' },
        timeout: { type: 'number', description: 'Max wait time in ms (default: 10000)' }
      }
    },
    async execute(input, context) {
      try {
        const page = await getPage();
        const timeout = input.timeout || 10000;

        if (input.selector) {
          await page.waitForSelector(input.selector, { timeout });
          return { success: true, output: `Selector "${input.selector}" appeared.` };
        }

        if (input.text) {
          await page.waitForFunction(
            (t) => document.body?.innerText?.includes(t),
            { timeout },
            input.text
          );
          return { success: true, output: `Text "${input.text}" appeared on page.` };
        }

        if (input.navigation) {
          await page.waitForNavigation({ waitUntil: 'networkidle2', timeout });
          return { success: true, output: `Navigation completed. URL: ${page.url()}` };
        }

        if (input.delay) {
          await new Promise(r => setTimeout(r, input.delay));
          return { success: true, output: `Waited ${input.delay}ms.` };
        }

        return { success: true, output: 'No wait condition specified.' };
      } catch (err) {
        return { success: false, output: '', error: err.message };
      }
    }
  },

  {
    name: 'browser_tabs',
    description: 'Manage browser tabs — list open tabs, switch between them, open a new tab, or close a tab. Useful for multi-tab workflows.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'Action to perform: "list", "new", "switch", "close"', enum: ['list', 'new', 'switch', 'close'] },
        index: { type: 'number', description: 'Tab index (for switch/close actions)' },
        url: { type: 'string', description: 'URL to open in a new tab (for "new" action)' }
      },
      required: ['action']
    },
    async execute(input, context) {
      try {
        const b = await getBrowser();
        const allPages = await b.pages();

        switch (input.action) {
          case 'list': {
            const tabInfo = await Promise.all(allPages.map(async (p, i) => ({
              index: i,
              title: await p.title().catch(() => '(untitled)'),
              url: p.url(),
              active: p === activePage
            })));
            return { success: true, output: JSON.stringify(tabInfo, null, 2) };
          }

          case 'new': {
            const newPage = await b.newPage();
            activePage = newPage;
            if (input.url) {
              await newPage.goto(input.url, { waitUntil: 'networkidle2', timeout: 30000 });
            }
            const title = await newPage.title();
            return {
              success: true,
              output: JSON.stringify({ message: 'New tab opened', title, url: newPage.url() }, null, 2)
            };
          }

          case 'switch': {
            if (input.index === undefined || input.index >= allPages.length) {
              return { success: false, output: '', error: `Invalid tab index. ${allPages.length} tabs open.` };
            }
            activePage = allPages[input.index];
            await activePage.bringToFront();
            const title = await activePage.title();
            return {
              success: true,
              output: JSON.stringify({ message: `Switched to tab ${input.index}`, title, url: activePage.url() }, null, 2)
            };
          }

          case 'close': {
            const idx = input.index ?? allPages.indexOf(activePage);
            if (idx >= 0 && idx < allPages.length) {
              await allPages[idx].close();
              const remaining = await b.pages();
              activePage = remaining.length > 0 ? remaining[0] : null;
              return { success: true, output: `Tab ${idx} closed. ${remaining.length} tabs remaining.` };
            }
            return { success: false, output: '', error: 'Invalid tab index.' };
          }

          default:
            return { success: false, output: '', error: `Unknown action: ${input.action}` };
        }
      } catch (err) {
        return { success: false, output: '', error: err.message };
      }
    }
  },

  {
    name: 'browser_cookies',
    description: 'Get or set cookies for the current page. Useful for session management, staying logged in, etc.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: '"get" to read cookies or "set" to add cookies', enum: ['get', 'set', 'clear'] },
        cookies: {
          type: 'array',
          description: 'Cookies to set (for "set" action). Each: { name, value, domain, path, httpOnly, secure }',
          items: { type: 'object' }
        },
        domain: { type: 'string', description: 'Filter cookies by domain (for "get" action)' }
      },
      required: ['action']
    },
    async execute(input, context) {
      try {
        const page = await getPage();

        switch (input.action) {
          case 'get': {
            let cookies = await page.cookies();
            if (input.domain) {
              cookies = cookies.filter(c => c.domain.includes(input.domain));
            }
            // Mask values for safety in output
            const safe = cookies.map(c => ({
              name: c.name,
              domain: c.domain,
              path: c.path,
              secure: c.secure,
              httpOnly: c.httpOnly,
              expires: c.expires,
              valuePreview: c.value.substring(0, 20) + (c.value.length > 20 ? '...' : '')
            }));
            return { success: true, output: JSON.stringify(safe, null, 2) };
          }

          case 'set': {
            if (!input.cookies || input.cookies.length === 0) {
              return { success: false, output: '', error: 'No cookies provided.' };
            }
            await page.setCookie(...input.cookies);
            return { success: true, output: `Set ${input.cookies.length} cookie(s).` };
          }

          case 'clear': {
            const cookies = await page.cookies();
            if (cookies.length > 0) {
              await page.deleteCookie(...cookies);
            }
            return { success: true, output: `Cleared ${cookies.length} cookie(s).` };
          }

          default:
            return { success: false, output: '', error: `Unknown action: ${input.action}` };
        }
      } catch (err) {
        return { success: false, output: '', error: err.message };
      }
    }
  },

  {
    name: 'browser_close',
    description: 'Close the browser completely. Use when you are done with all browser tasks. A new browser will be launched automatically on the next browser tool call.',
    parameters: {
      type: 'object',
      properties: {},
      required: []
    },
    async execute(input, context) {
      try {
        if (browser && browser.connected) {
          await browser.close();
        }
        browser = null;
        activePage = null;
        pages.clear();
        return { success: true, output: 'Browser closed.' };
      } catch (err) {
        return { success: false, output: '', error: err.message };
      }
    }
  }
];

export default tools;
