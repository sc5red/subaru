import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import defaults from './defaults.js';
import logger from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..', '..');
const configPath = path.join(projectRoot, 'subaru.config.json');

function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === 'object' &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === 'object' &&
      !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(target[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

function loadConfig() {
  let fileConfig = {};

  if (fs.existsSync(configPath)) {
    try {
      const raw = fs.readFileSync(configPath, 'utf-8');
      fileConfig = JSON.parse(raw);
    } catch (err) {
      logger.warn(`Failed to parse subaru.config.json: ${err.message}. Using defaults.`);
    }
  } else {
    logger.info('No subaru.config.json found — generating from defaults.');
    fs.writeFileSync(configPath, JSON.stringify(defaults, null, 2), 'utf-8');
    fileConfig = { ...defaults };
  }

  let config = deepMerge(defaults, fileConfig);

  // Override with .env values
  if (process.env.LLM_PROVIDER) config.llm.provider = process.env.LLM_PROVIDER;
  if (process.env.LLM_API_KEY) config.llm.apiKey = process.env.LLM_API_KEY;
  if (process.env.LLM_BASE_URL) config.llm.baseURL = process.env.LLM_BASE_URL;
  if (process.env.LLM_MODEL) config.llm.model = process.env.LLM_MODEL;
  if (process.env.TELEGRAM_BOT_TOKEN) {
    config.interfaces.telegram.botToken = process.env.TELEGRAM_BOT_TOKEN;
  }
  if (process.env.STT_API_URL) {
    if (!config.stt) config.stt = {};
    config.stt.apiUrl = process.env.STT_API_URL;
  }
  if (process.env.STT_API_KEY) {
    if (!config.stt) config.stt = {};
    config.stt.apiKey = process.env.STT_API_KEY;
  }
  if (process.env.STT_MODEL) {
    if (!config.stt) config.stt = {};
    config.stt.model = process.env.STT_MODEL;
  }

  config._projectRoot = projectRoot;
  config._configPath = configPath;

  return Object.freeze(config);
}

/**
 * Save a partial config update back to the config file.
 */
export function saveConfig(updates) {
  let existing = {};
  if (fs.existsSync(configPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch { /* start fresh */ }
  }
  const merged = deepMerge(existing, updates);
  fs.writeFileSync(configPath, JSON.stringify(merged, null, 2), 'utf-8');
  return merged;
}

/**
 * Return a sanitized config (no API keys).
 */
export function sanitizeConfig(config) {
  const safe = JSON.parse(JSON.stringify(config));
  if (safe.llm) safe.llm.apiKey = safe.llm.apiKey ? '***' : '';
  if (safe.interfaces?.telegram) {
    safe.interfaces.telegram.botToken = safe.interfaces.telegram.botToken ? '***' : '';
  }
  delete safe._projectRoot;
  delete safe._configPath;
  return safe;
}

const config = loadConfig();
export default config;
