import { EventEmitter } from 'node:events';
import { existsSync, createReadStream } from 'node:fs';
import path from 'node:path';
import * as agent from '../../agent/agent.js';
import * as shortTerm from '../../memory/shortTerm.js';
import * as registry from '../../tools/registry.js';
import { sanitizeConfig, saveConfig } from '../../config/config.js';
import { createConfirmationHandler, resolveConfirmation, getPendingConfirmations } from '../../safety/confirmation.js';
import config from '../../config/config.js';
import logger from '../../utils/logger.js';

const IMAGE_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

// Task tracking for SSE streams
const activeTasks = new Map();

/**
 * Mount all routes onto the Express app.
 */
export function mountRoutes(app) {
  const confirmationFn = createConfirmationHandler('web');

  // POST /api/chat — initiate an agent run
  app.post('/api/chat', (req, res) => {
    const { message, sessionId = 'web_default', images } = req.body;

    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid "message" field.' });
    }

    // Validate images if provided: [{ data: 'base64...', mimeType: 'image/png' }]
    let validImages = undefined;
    if (Array.isArray(images) && images.length > 0) {
      validImages = images.filter(img => img && typeof img.data === 'string' && typeof img.mimeType === 'string');
      if (validImages.length === 0) validImages = undefined;
    }

    const taskId = `task_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const emitter = new EventEmitter();
    const events = [];

    emitter.on('token', (data) => events.push({ type: 'token', ...data }));
    emitter.on('tool_call', (data) => events.push({ type: 'tool_call', ...data }));
    emitter.on('tool_result', (data) => events.push({ type: 'tool_result', ...data }));
    emitter.on('done', (data) => events.push({ type: 'done', ...data }));
    emitter.on('error', (data) => events.push({ type: 'error', ...data }));

    activeTasks.set(taskId, { emitter, events, done: false, sessionId });

    // Run agent asynchronously
    agent.run(message, sessionId, emitter, { confirmationFn, images: validImages })
      .then(() => {
        const task = activeTasks.get(taskId);
        if (task) task.done = true;
      })
      .catch((err) => {
        const task = activeTasks.get(taskId);
        if (task) {
          task.events.push({ type: 'error', message: err.message });
          task.done = true;
        }
      });

    res.json({ taskId, sessionId });
  });

  // GET /api/stream/:taskId — Server-Sent Events stream
  app.get('/api/stream/:taskId', (req, res) => {
    const { taskId } = req.params;
    const task = activeTasks.get(taskId);

    if (!task) {
      return res.status(404).json({ error: 'Task not found.' });
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });

    let eventIndex = 0;

    // Send any already-buffered events
    function flushEvents() {
      while (eventIndex < task.events.length) {
        const event = task.events[eventIndex];
        res.write(`data: ${JSON.stringify(event)}\n\n`);
        eventIndex++;
      }
    }

    flushEvents();

    // Listen for new events
    const onToken = (data) => {
      flushEvents();
    };
    const onToolCall = (data) => {
      flushEvents();
    };
    const onToolResult = (data) => {
      flushEvents();
    };
    const onDone = (data) => {
      flushEvents();
      res.write(`data: ${JSON.stringify({ type: 'stream_end' })}\n\n`);
      cleanup();
      // Clean up task after a delay
      setTimeout(() => activeTasks.delete(taskId), 60000);
    };
    const onError = (data) => {
      flushEvents();
    };

    task.emitter.on('token', onToken);
    task.emitter.on('tool_call', onToolCall);
    task.emitter.on('tool_result', onToolResult);
    task.emitter.on('done', onDone);
    task.emitter.on('error', onError);

    function cleanup() {
      task.emitter.off('token', onToken);
      task.emitter.off('tool_call', onToolCall);
      task.emitter.off('tool_result', onToolResult);
      task.emitter.off('done', onDone);
      task.emitter.off('error', onError);
    }

    // If already done, send end signal
    if (task.done) {
      flushEvents();
      res.write(`data: ${JSON.stringify({ type: 'stream_end' })}\n\n`);
      cleanup();
    }

    req.on('close', () => {
      cleanup();
    });
  });

  // GET /api/history — returns recent conversation turns
  app.get('/api/history', (req, res) => {
    const sessionId = req.query.sessionId || 'web_default';
    const history = shortTerm.getHistory(sessionId);
    res.json({
      sessionId,
      messages: history.map(m => ({
        role: m.role,
        content: m.content,
        timestamp: m.timestamp,
        name: m.name
      }))
    });
  });

  // DELETE /api/history — clears short-term memory
  app.delete('/api/history', (req, res) => {
    const sessionId = req.query.sessionId || 'web_default';
    shortTerm.clearHistory(sessionId);
    res.json({ success: true, message: 'History cleared.' });
  });

  // GET /api/tools — returns list of loaded tools
  app.get('/api/tools', (req, res) => {
    const tools = registry.getAllTools();
    res.json(tools.map(t => ({
      name: t.name,
      description: t.description,
      enabled: true
    })));
  });

  // GET /api/config — returns sanitized config
  app.get('/api/config', (req, res) => {
    res.json(sanitizeConfig(config));
  });

  // POST /api/config — updates writable config fields
  app.post('/api/config', (req, res) => {
    try {
      const updates = req.body;
      // Prevent editing sensitive fields from web
      if (updates.llm?.apiKey) delete updates.llm.apiKey;
      const merged = saveConfig(updates);
      res.json({ success: true, config: sanitizeConfig(merged) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/confirm/:confirmationId — resolve a pending confirmation
  app.post('/api/confirm/:confirmationId', (req, res) => {
    const { confirmationId } = req.params;
    const { approved } = req.body;
    const resolved = resolveConfirmation(confirmationId, !!approved);
    if (resolved) {
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'Confirmation not found or already resolved.' });
    }
  });

  // GET /api/confirmations — get pending confirmations
  app.get('/api/confirmations', (req, res) => {
    res.json(getPendingConfirmations());
  });

  // GET /api/image — serve an image file from the local filesystem
  app.get('/api/image', (req, res) => {
    const filePath = req.query.path;
    if (!filePath || typeof filePath !== 'string') {
      return res.status(400).json({ error: 'Missing "path" query parameter.' });
    }
    if (!existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found.' });
    }
    const ext = path.extname(filePath).toLowerCase();
    const mime = IMAGE_MIME[ext];
    if (!mime) {
      return res.status(400).json({ error: `Unsupported image format: ${ext}` });
    }
    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    createReadStream(filePath).pipe(res);
  });

  // --- Plugin Management ---

  // GET /api/plugins — list installed plugins
  app.get('/api/plugins', (req, res) => {
    try {
      const plugins = registry.listPlugins();
      res.json(plugins);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/plugins — create/save a plugin file
  app.post('/api/plugins', (req, res) => {
    try {
      const { filename, content } = req.body;
      if (!filename || !content) {
        return res.status(400).json({ error: 'filename and content are required.' });
      }
      const savedName = registry.savePlugin(filename, content);
      res.json({ success: true, name: savedName });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /api/plugins/:name — delete a plugin file
  app.delete('/api/plugins/:name', (req, res) => {
    try {
      const deleted = registry.deletePlugin(req.params.name);
      if (deleted) {
        res.json({ success: true });
      } else {
        res.status(404).json({ error: 'Plugin not found.' });
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/plugins/reload — reload all plugins
  app.post('/api/plugins/reload', async (req, res) => {
    try {
      await registry.reloadPlugins();
      res.json({ success: true, message: 'Plugins reloaded.' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

export default { mountRoutes };
