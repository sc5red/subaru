const defaults = {
  llm: {
    provider: 'ollama',
    model: 'qwen3.5:397b-cloud',
    baseURL: 'http://localhost:11434',
    apiKey: ''
  },
  interfaces: {
    cli: { enabled: true },
    web: { enabled: true, port: 3131 },
    telegram: { enabled: false, botToken: '' }
  },
  tools: {
    filesystem: {
      enabled: true,
      allowedPaths: ['~/autonome-workspace'],
      blockedPaths: ['/etc', '/sys', '/boot', '~/.ssh']
    },
    shell: {
      enabled: true,
      requireConfirmation: true,
      blockedCommands: ['rm -rf /', 'mkfs', 'dd if='],
      timeout: 30000
    },
    http: { enabled: true },
    code: { enabled: true, timeout: 10000 },
    database: { enabled: true, path: './data/memory.db' },
    git: { enabled: true },
    browser: { enabled: true, headless: true, timeout: 30000 },
    display: { enabled: true }
  },
  memory: {
    shortTermMaxMessages: 100,
    longTermEnabled: true,
    vectorSimilarityThreshold: 0.7
  },
  safety: {
    confirmDangerousCommands: true,
    sandboxShell: false
  },
  stt: {
    apiUrl: '',
    apiKey: '',
    model: 'whisper-large-v3-turbo'
  }
};

export default defaults;
