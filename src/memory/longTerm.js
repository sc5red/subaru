import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import logger from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..', '..');
const vectorsDir = path.join(projectRoot, 'data', 'vectors');
const memoriesPath = path.join(vectorsDir, 'memories.json');

let memories = [];
let embedFn = null;
let fallbackMode = false;

/**
 * Initialize long-term memory.
 * @param {Function} embedFunction - async function that takes text and returns float array
 */
export async function init(embedFunction) {
  embedFn = embedFunction;

  // Ensure directories exist
  if (!fs.existsSync(vectorsDir)) {
    fs.mkdirSync(vectorsDir, { recursive: true });
  }

  // Load existing memories
  if (fs.existsSync(memoriesPath)) {
    try {
      const raw = fs.readFileSync(memoriesPath, 'utf-8');
      memories = JSON.parse(raw);
      logger.info(`Loaded ${memories.length} long-term memories.`);
    } catch (err) {
      logger.warn(`Failed to load memories: ${err.message}. Starting fresh.`);
      memories = [];
    }
  } else {
    memories = [];
  }

  // Probe embeddings at startup — if they fail, enter fallback mode immediately
  if (embedFn) {
    try {
      await embedFn('test');
      logger.info('Embedding model available. Long-term memory using vector similarity.');
    } catch {
      fallbackMode = true;
      logger.info('Embedding model not available. Long-term memory using keyword similarity.');
    }
  } else {
    fallbackMode = true;
  }
}

/**
 * Store text with metadata into long-term memory.
 */
export async function store(text, metadata = {}) {
  try {
    let embedding;
    if (embedFn && !fallbackMode) {
      try {
        embedding = await embedFn(text);
      } catch (err) {
        logger.warn(`Embedding failed, switching to fallback mode: ${err.message}`);
        fallbackMode = true;
        embedding = bagOfWordsVector(text);
      }
    } else {
      embedding = bagOfWordsVector(text);
    }

    const memory = {
      id: `mem_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
      text,
      embedding,
      metadata: {
        ...metadata,
        timestamp: Date.now()
      }
    };

    memories.push(memory);
    save();
    logger.debug(`Stored memory: ${text.substring(0, 80)}...`);
  } catch (err) {
    logger.error(`Failed to store memory: ${err.message}`);
  }
}

/**
 * Recall similar memories by querying with text.
 */
export async function recall(queryText, topK = 5, threshold = 0.75) {
  if (memories.length === 0) return [];

  try {
    let queryEmbedding;
    if (embedFn && !fallbackMode) {
      try {
        queryEmbedding = await embedFn(queryText);
      } catch {
        fallbackMode = true;
        queryEmbedding = bagOfWordsVector(queryText);
      }
    } else {
      queryEmbedding = bagOfWordsVector(queryText);
    }

    const scored = memories
      .map(mem => ({
        text: mem.text,
        similarity: cosineSimilarity(queryEmbedding, mem.embedding),
        metadata: mem.metadata
      }))
      .filter(m => m.similarity >= threshold)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, topK);

    return scored;
  } catch (err) {
    logger.error(`Failed to recall memories: ${err.message}`);
    return [];
  }
}

/**
 * Clear all long-term memories.
 */
export async function clear() {
  memories = [];
  save();
  logger.info('Long-term memory cleared.');
}

/**
 * Save memories to disk.
 */
function save() {
  try {
    if (!fs.existsSync(vectorsDir)) {
      fs.mkdirSync(vectorsDir, { recursive: true });
    }
    fs.writeFileSync(memoriesPath, JSON.stringify(memories, null, 2), 'utf-8');
  } catch (err) {
    logger.error(`Failed to save memories to disk: ${err.message}`);
  }
}

/**
 * Cosine similarity between two vectors.
 */
function cosineSimilarity(a, b) {
  if (!a || !b || a.length === 0 || b.length === 0) return 0;

  // If arrays have different lengths (fallback vs real vectors), use bag-of-words approach
  if (a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;
  return dotProduct / denominator;
}

/**
 * Fallback: bag-of-words vector using hash trick for fixed-dimension vectors.
 * Produces consistent 256-dim vectors regardless of vocabulary size.
 */
const BOW_DIM = 256;

function bagOfWordsVector(text) {
  const words = text.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter(w => w.length > 2);
  const vector = new Array(BOW_DIM).fill(0);

  for (const word of words) {
    // Simple hash: sum of char codes mod dimension
    let hash = 0;
    for (let i = 0; i < word.length; i++) {
      hash = (hash * 31 + word.charCodeAt(i)) >>> 0;
    }
    const idx = hash % BOW_DIM;
    vector[idx] += 1;
  }

  return vector;
}

export default { init, store, recall, clear };
