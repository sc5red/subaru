import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import logger from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..', '..');

const tools = new Map();

/**
 * Register a tool.
 */
export function registerTool(tool) {
  if (!tool.name || !tool.execute) {
    logger.warn(`Invalid tool registration attempt: missing name or execute`);
    return;
  }
  tools.set(tool.name, tool);
  logger.debug(`Registered tool: ${tool.name}`);
}

/**
 * Register multiple tools from a module (module exports a tools array).
 */
export function registerTools(toolsArray) {
  for (const tool of toolsArray) {
    registerTool(tool);
  }
}

/**
 * Get a tool by name.
 */
export function getTool(name) {
  return tools.get(name) || null;
}

/**
 * Get all registered tools.
 */
export function getAllTools() {
  return Array.from(tools.values());
}

/**
 * Dispatch a tool call.
 */
export async function dispatch(name, input, context) {
  const tool = tools.get(name);
  if (!tool) {
    return { success: false, output: '', error: `Tool not found: ${name}` };
  }

  try {
    logger.debug(`Dispatching tool: ${name}`, input);
    const result = await tool.execute(input, context);
    return result;
  } catch (err) {
    logger.error(`Tool ${name} execution error: ${err.message}`);
    return { success: false, output: '', error: err.message };
  }
}

/**
 * Load all enabled tools from config.
 */
export async function loadTools(config) {
  const toolModules = [
    { key: 'filesystem', loader: () => import('./filesystem.js') },
    { key: 'shell', loader: () => import('./shell.js') },
    { key: 'http', loader: () => import('./http.js') },
    { key: 'code', loader: () => import('./code.js') },
    { key: 'database', loader: () => import('./database.js') },
    { key: 'git', loader: () => import('./git.js') },
    { key: 'browser', loader: () => import('./browser.js') },
    { key: 'display', loader: () => import('./display.js') }
  ];

  for (const { key, loader } of toolModules) {
    const toolConfig = config.tools?.[key];
    if (toolConfig && toolConfig.enabled !== false) {
      try {
        const mod = await loader();
        const toolsArray = mod.default || mod.tools || [];
        if (Array.isArray(toolsArray)) {
          registerTools(toolsArray);
        }
        logger.info(`Loaded tool module: ${key}`);
      } catch (err) {
        logger.error(`Failed to load tool module ${key}: ${err.message}`);
      }
    } else {
      logger.info(`Tool module disabled: ${key}`);
    }
  }

  logger.info(`Total built-in tools registered: ${tools.size}`);

  // Load plugins from plugins/ directory
  await loadPlugins();

  logger.info(`Total tools registered (with plugins): ${tools.size}`);
}

/**
 * Load custom tool plugins from the plugins/ directory.
 * Each .js file should default-export an array of tool objects (same shape as built-in tools).
 */
export async function loadPlugins() {
  const pluginsDir = path.join(projectRoot, 'plugins');
  if (!fs.existsSync(pluginsDir)) return;

  let files;
  try {
    files = fs.readdirSync(pluginsDir).filter(f => f.endsWith('.js'));
  } catch (err) {
    logger.warn(`Could not read plugins directory: ${err.message}`);
    return;
  }

  for (const file of files) {
    const filePath = path.join(pluginsDir, file);
    try {
      const mod = await import(pathToFileURL(filePath).href);
      const pluginTools = mod.default || mod.tools || [];
      if (Array.isArray(pluginTools)) {
        registerTools(pluginTools);
        logger.info(`Loaded plugin: ${file} (${pluginTools.length} tools)`);
      } else if (pluginTools.name && pluginTools.execute) {
        // Single tool export
        registerTool(pluginTools);
        logger.info(`Loaded plugin: ${file} (1 tool)`);
      }
    } catch (err) {
      logger.error(`Failed to load plugin ${file}: ${err.message}`);
    }
  }
}

/**
 * List plugin files in the plugins/ directory.
 */
export function listPlugins() {
  const pluginsDir = path.join(projectRoot, 'plugins');
  if (!fs.existsSync(pluginsDir)) return [];
  try {
    return fs.readdirSync(pluginsDir)
      .filter(f => f.endsWith('.js'))
      .map(f => {
        const filePath = path.join(pluginsDir, f);
        const stat = fs.statSync(filePath);
        let content = '';
        try { content = fs.readFileSync(filePath, 'utf-8'); } catch {}
        return { name: f, size: stat.size, modified: stat.mtime.toISOString(), content };
      });
  } catch { return []; }
}

/**
 * Save a plugin file to the plugins/ directory.
 */
export function savePlugin(filename, content) {
  const pluginsDir = path.join(projectRoot, 'plugins');
  if (!fs.existsSync(pluginsDir)) fs.mkdirSync(pluginsDir, { recursive: true });
  if (!filename.endsWith('.js')) filename += '.js';
  // Sanitize filename
  const safe = filename.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
  const filePath = path.join(pluginsDir, safe);
  fs.writeFileSync(filePath, content, 'utf-8');
  logger.info(`Saved plugin file: ${safe}`);
  return safe;
}

/**
 * Delete a plugin file from the plugins/ directory.
 */
export function deletePlugin(filename) {
  const pluginsDir = path.join(projectRoot, 'plugins');
  const safe = filename.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
  const filePath = path.join(pluginsDir, safe);
  if (!fs.existsSync(filePath)) return false;
  fs.unlinkSync(filePath);
  logger.info(`Deleted plugin file: ${safe}`);
  return true;
}

/**
 * Reload all plugins (unregister plugin tools, re-load from disk).
 */
export async function reloadPlugins() {
  // We can't easily unregister only plugin tools without tracking them,
  // so we clear all tools and reload everything (built-in + plugins).
  // For now, just reload plugins on top (duplicates are overwritten by Map).
  await loadPlugins();
  logger.info('Plugins reloaded');
}

export default { registerTool, registerTools, getTool, getAllTools, dispatch, loadTools, listPlugins, savePlugin, deletePlugin, reloadPlugins };
