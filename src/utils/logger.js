import chalk from 'chalk';

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

class Logger {
  constructor() {
    this.level = LEVELS[process.env.LOG_LEVEL?.toLowerCase()] ?? LEVELS.info;
  }

  _timestamp() {
    return new Date().toISOString().replace('T', ' ').substring(0, 19);
  }

  _format(level, msg, ...args) {
    const ts = chalk.gray(this._timestamp());
    let tag;
    switch (level) {
      case 'debug': tag = chalk.magenta('[DEBUG]'); break;
      case 'info':  tag = chalk.cyan('[INFO] '); break;
      case 'warn':  tag = chalk.yellow('[WARN] '); break;
      case 'error': tag = chalk.red('[ERROR]'); break;
      default:      tag = chalk.white(`[${level.toUpperCase()}]`);
    }
    const message = args.length ? `${msg} ${args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ')}` : msg;
    return `${ts} ${tag} ${message}`;
  }

  debug(msg, ...args) {
    if (this.level <= LEVELS.debug) console.log(this._format('debug', msg, ...args));
  }

  info(msg, ...args) {
    if (this.level <= LEVELS.info) console.log(this._format('info', msg, ...args));
  }

  warn(msg, ...args) {
    if (this.level <= LEVELS.warn) console.warn(this._format('warn', msg, ...args));
  }

  error(msg, ...args) {
    if (this.level <= LEVELS.error) console.error(this._format('error', msg, ...args));
  }

  setLevel(level) {
    if (LEVELS[level] !== undefined) {
      this.level = LEVELS[level];
    }
  }
}

const logger = new Logger();
export default logger;
