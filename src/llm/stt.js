import fs from 'node:fs';
import path from 'node:path';
import logger from '../utils/logger.js';
import config from '../config/config.js';

/**
 * Speech-to-Text service.
 * 
 * Supports any OpenAI-compatible Whisper endpoint:
 *   - Local whisper.cpp server (https://github.com/ggerganov/whisper.cpp)
 *   - Groq (https://console.groq.com — free whisper-large-v3-turbo)
 *   - OpenAI (https://api.openai.com)
 * 
 * Configure via .env:
 *   STT_API_URL=https://api.groq.com/openai/v1/audio/transcriptions
 *   STT_API_KEY=your-key
 *   STT_MODEL=whisper-large-v3-turbo
 */

/**
 * Transcribe an audio file to text.
 * @param {string} filePath - Path to the audio file (ogg, mp3, wav, m4a, etc.)
 * @returns {Promise<string>} - The transcribed text
 */
export async function transcribe(filePath) {
  const sttUrl = config.stt?.apiUrl || process.env.STT_API_URL;
  const sttKey = config.stt?.apiKey || process.env.STT_API_KEY;
  const sttModel = config.stt?.model || process.env.STT_MODEL || 'whisper-large-v3-turbo';

  if (!sttUrl) {
    throw new Error('STT not configured. Set STT_API_URL in .env (e.g., https://api.groq.com/openai/v1/audio/transcriptions)');
  }

  logger.debug(`STT: transcribing ${filePath} via ${sttUrl} model=${sttModel}`);

  // Build multipart form data manually with native fetch
  const fileBuffer = fs.readFileSync(filePath);
  const fileName = path.basename(filePath);
  const ext = path.extname(filePath).toLowerCase();

  // Detect content type from file extension
  const MIME_MAP = {
    '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.flac': 'audio/flac',
    '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.wma': 'audio/x-ms-wma',
    '.webm': 'audio/webm'
  };
  const contentType = MIME_MAP[ext] || 'application/octet-stream';

  const boundary = `----SubaruSTT${Date.now()}`;
  const parts = [];

  // File part
  parts.push(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
    `Content-Type: ${contentType}\r\n\r\n`
  );
  parts.push(fileBuffer);
  parts.push('\r\n');

  // Model part
  parts.push(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="model"\r\n\r\n` +
    `${sttModel}\r\n`
  );

  // Response format
  parts.push(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="response_format"\r\n\r\n` +
    `json\r\n`
  );

  parts.push(`--${boundary}--\r\n`);

  // Concatenate into a single buffer
  const bodyParts = parts.map(p => typeof p === 'string' ? Buffer.from(p, 'utf-8') : p);
  const body = Buffer.concat(bodyParts);

  const headers = {
    'Content-Type': `multipart/form-data; boundary=${boundary}`
  };
  if (sttKey) {
    headers['Authorization'] = `Bearer ${sttKey}`;
  }

  const response = await fetch(sttUrl, {
    method: 'POST',
    headers,
    body
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`STT API error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const text = data.text?.trim();

  if (!text) {
    throw new Error('STT returned empty transcription');
  }

  logger.info(`STT: transcribed ${text.length} chars from ${fileName}`);
  return text;
}

export default { transcribe };
