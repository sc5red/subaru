import vm from 'node:vm';
import logger from '../utils/logger.js';

const tools = [
  {
    name: 'execute_node',
    description: 'Execute a JavaScript code snippet in a sandboxed environment. Has access to console.log, Math, JSON, Date, but NOT require, import, process, fs, or network. Returns captured console output and the return value.',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'The JavaScript code to execute' },
        timeout: { type: 'number', description: 'Execution timeout in milliseconds (default: 10000)' }
      },
      required: ['code']
    },
    async execute(input, context) {
      const { code, timeout } = input;
      const timeoutMs = timeout || context.config?.tools?.code?.timeout || 10000;
      const logs = [];

      const sandbox = {
        console: {
          log: (...args) => logs.push(args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')),
          error: (...args) => logs.push('[ERROR] ' + args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')),
          warn: (...args) => logs.push('[WARN] ' + args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')),
          info: (...args) => logs.push(args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '))
        },
        Math,
        JSON,
        Date,
        Array,
        Object,
        String,
        Number,
        Boolean,
        RegExp,
        Map,
        Set,
        Promise,
        parseInt,
        parseFloat,
        isNaN,
        isFinite,
        encodeURIComponent,
        decodeURIComponent,
        encodeURI,
        decodeURI,
        setTimeout: undefined,
        setInterval: undefined,
        setImmediate: undefined,
        process: undefined,
        require: undefined,
        __filename: undefined,
        __dirname: undefined,
        global: undefined,
        globalThis: undefined
      };

      try {
        const ctx = vm.createContext(sandbox);
        const result = vm.runInContext(code, ctx, {
          timeout: timeoutMs,
          displayErrors: true
        });

        const output = logs.join('\n');
        const returnValue = result !== undefined ? (typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result)) : undefined;

        return {
          success: true,
          output: JSON.stringify({ output, returnValue }, null, 2)
        };
      } catch (err) {
        return {
          success: false,
          output: logs.join('\n'),
          error: err.message
        };
      }
    }
  },
  {
    name: 'evaluate_expression',
    description: 'Safely evaluate a mathematical or logical expression. Returns the computed result.',
    parameters: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: 'The expression to evaluate (e.g., "2 + 2", "Math.sqrt(144)")' }
      },
      required: ['expression']
    },
    async execute(input, context) {
      const { expression } = input;

      const sandbox = {
        Math,
        parseInt,
        parseFloat,
        isNaN,
        isFinite,
        Number,
        Boolean
      };

      try {
        const ctx = vm.createContext(sandbox);
        const result = vm.runInContext(expression, ctx, { timeout: 5000 });
        return {
          success: true,
          output: String(result)
        };
      } catch (err) {
        return { success: false, output: '', error: err.message };
      }
    }
  }
];

export default tools;
