import logger from '../utils/logger.js';
import { truncate } from '../utils/format.js';

const tools = [
  {
    name: 'http_request',
    description: 'Make an HTTP/HTTPS request to a URL. Supports GET, POST, PUT, PATCH, DELETE methods. Returns status, headers, and response body.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to request' },
        method: { type: 'string', description: 'HTTP method (GET, POST, PUT, PATCH, DELETE). Default: GET', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
        headers: { type: 'object', description: 'Request headers as key-value pairs' },
        body: { type: 'string', description: 'Request body (for POST/PUT/PATCH)' },
        timeout: { type: 'number', description: 'Request timeout in milliseconds (default: 30000)' }
      },
      required: ['url']
    },
    async execute(input, context) {
      const { url, method = 'GET', headers = {}, body, timeout = 30000 } = input;

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);

        const fetchOptions = {
          method,
          headers,
          signal: controller.signal
        };

        if (body && ['POST', 'PUT', 'PATCH'].includes(method.toUpperCase())) {
          fetchOptions.body = body;
          if (!headers['Content-Type'] && !headers['content-type']) {
            fetchOptions.headers['Content-Type'] = 'application/json';
          }
        }

        logger.debug(`HTTP ${method} ${url}`);
        const response = await fetch(url, fetchOptions);
        clearTimeout(timeoutId);

        const contentType = response.headers.get('content-type') || '';
        let responseBody;

        if (contentType.includes('application/json')) {
          try {
            responseBody = await response.json();
            responseBody = JSON.stringify(responseBody, null, 2);
          } catch {
            responseBody = await response.text();
          }
        } else {
          responseBody = await response.text();
        }

        // Truncate if too large
        const maxLen = 50 * 1024; // 50KB
        const truncated = responseBody.length > maxLen;
        if (truncated) {
          responseBody = responseBody.substring(0, maxLen) + '\n...[truncated, original size: ' + responseBody.length + ' bytes]';
        }

        const respHeaders = {};
        response.headers.forEach((value, key) => {
          respHeaders[key] = value;
        });

        const output = JSON.stringify({
          status: response.status,
          statusText: response.statusText,
          headers: respHeaders,
          body: responseBody,
          truncated
        }, null, 2);

        return { success: response.ok, output };
      } catch (err) {
        if (err.name === 'AbortError') {
          return { success: false, output: '', error: `Request timed out after ${timeout}ms` };
        }
        return { success: false, output: '', error: err.message };
      }
    }
  }
];

export default tools;
