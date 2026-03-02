import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import logger from '../utils/logger.js';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.tiff', '.ico']);

const tools = [
  {
    name: 'display_image',
    description:
      'Send an image file to the user so they can see it. Use this whenever the user should see an image — screenshots, downloaded images, generated charts, etc. ' +
      'The image will be displayed directly in the chat interface. Accepts any common image format (PNG, JPG, GIF, WebP, etc.).',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path to the image file to display'
        },
        caption: {
          type: 'string',
          description: 'Optional caption to show with the image'
        }
      },
      required: ['path']
    },
    async execute(input) {
      const filePath = input.path;

      if (!filePath) {
        return { success: false, output: '', error: 'No file path provided' };
      }

      if (!existsSync(filePath)) {
        return { success: false, output: '', error: `File not found: ${filePath}` };
      }

      const ext = path.extname(filePath).toLowerCase();
      if (!IMAGE_EXTENSIONS.has(ext)) {
        return { success: false, output: '', error: `Not a supported image format (${ext}). Supported: ${[...IMAGE_EXTENSIONS].join(', ')}` };
      }

      const stats = statSync(filePath);
      const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);

      if (stats.size > 50 * 1024 * 1024) {
        return { success: false, output: '', error: `Image too large (${sizeMB} MB). Maximum is 50 MB.` };
      }

      logger.info(`display_image: sending ${filePath} (${sizeMB} MB)`);

      // Return structured result — the interface handler intercepts this
      // and sends the image through the appropriate channel (Telegram photo, web embed, etc.)
      return {
        success: true,
        output: `__DISPLAY_IMAGE__:${filePath}:${input.caption || ''}`,
      };
    }
  }
];

export default tools;
