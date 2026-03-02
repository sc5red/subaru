import { EventEmitter } from 'node:events';

const eventBus = new EventEmitter();
eventBus.setMaxListeners(100);

export default eventBus;
