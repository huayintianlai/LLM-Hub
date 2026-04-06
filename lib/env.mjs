import fs from 'node:fs';
import path from 'node:path';

function stripQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

export function parseEnvContent(content) {
  const entries = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) {
      continue;
    }
    const index = line.indexOf('=');
    const key = line.slice(0, index).trim();
    const value = stripQuotes(line.slice(index + 1).trim());
    entries[key] = value;
  }
  return entries;
}

export function loadEnvFiles(customPaths = []) {
  const candidates = [
    path.resolve(process.cwd(), '.env'),
    path.resolve(process.cwd(), '.env.local'),
    path.resolve(process.cwd(), 'docs/.env'),
    ...customPaths.map((item) => path.resolve(process.cwd(), item)),
  ];

  const loaded = {};
  for (const filePath of candidates) {
    if (!fs.existsSync(filePath)) {
      continue;
    }
    const parsed = parseEnvContent(fs.readFileSync(filePath, 'utf8'));
    for (const [key, value] of Object.entries(parsed)) {
      if (!(key in process.env)) {
        process.env[key] = value;
      }
      loaded[key] = process.env[key];
    }
  }
  return loaded;
}

export function resolveEnvReference(value) {
  if (typeof value !== 'string') {
    return value;
  }
  if (!value.startsWith('os.environ/')) {
    return value;
  }
  const envName = value.slice('os.environ/'.length);
  return process.env[envName] || '';
}

export function resolveConfigReferences(value) {
  if (Array.isArray(value)) {
    return value.map((item) => resolveConfigReferences(item));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, resolveConfigReferences(item)])
    );
  }
  return resolveEnvReference(value);
}
