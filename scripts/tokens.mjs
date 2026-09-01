/**
 * tokens.mjs — Official Colby Ecosystem Node.js / ESM SDK for Secrets & Auth
 *
 * Provides zero-dependency access to the master `tokens` service for test scripts,
 * Cloudflare Worker test harnesses, background workers, and automation tasks.
 *
 * Usage:
 *   import { getWorkerApiKey, getCloudflareAccountId, getSecret, requireSecret } from './tokens.mjs';
 *
 *   const workerKey = getWorkerApiKey();
 *   const customSecret = requireSecret('MY_SERVICE_KEY');
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// In-memory cache to avoid repeated subprocess calls during test runs
const _cache = new Map();

/**
 * Known locations to discover the `tokens` CLI binary if not in standard PATH.
 */
const CANDIDATE_PATHS = [
  process.env.TOKENS_CLI_PATH,
  join(homedir(), '.local', 'bin', 'tokens'),
  join(homedir(), 'system-configs', 'tokens_cli', 'tokens'),
  '/Volumes/Projects/system-configs/tokens_cli/tokens',
  '/usr/local/bin/tokens',
  '/opt/homebrew/bin/tokens',
].filter(Boolean);

let _resolvedTokensBin = null;

/**
 * Locate the executable `tokens` CLI binary.
 * @returns {string} Path or command name
 */
export function resolveTokensBinary() {
  if (_resolvedTokensBin) return _resolvedTokensBin;

  // 1. Check PATH directly
  try {
    execFileSync('tokens', ['--version'], { stdio: 'ignore' });
    _resolvedTokensBin = 'tokens';
    return _resolvedTokensBin;
  } catch {
    // Not in PATH or error
  }

  // 2. Check candidate file paths
  for (const p of CANDIDATE_PATHS) {
    if (existsSync(p)) {
      _resolvedTokensBin = p;
      return _resolvedTokensBin;
    }
  }

  // Fallback to default name
  _resolvedTokensBin = 'tokens';
  return _resolvedTokensBin;
}

/**
 * Fetch a token from the tokens CLI without throwing if missing.
 * @param {string} name - Token identifier (e.g. 'WORKER_API_KEY')
 * @param {string|null} fallback - Optional fallback value if token is absent
 * @returns {string|null} The resolved token string or fallback
 */
export function getSecret(name, fallback = null) {
  if (!name || typeof name !== 'string') return fallback;

  if (_cache.has(name)) {
    return _cache.get(name);
  }

  const bin = resolveTokensBinary();
  try {
    const stdout = execFileSync(bin, ['show', name, '--value-only'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10000,
    });
    let val = stdout ? stdout.trim() : '';
    if (val.startsWith('{') && val.endsWith('}')) {
      try {
        const data = JSON.parse(val);
        val = data[name] || data[name.toUpperCase()] || '';
      } catch(error){
        console.log(error);
      }
    }
    if (val && val !== '[SECRET_FROM_STORE]') {
      _cache.set(name, val);
      return val;
    }
  } catch {
    // Process error (e.g. exit code 1 if not found)
  }

  return fallback;
}

/**
 * Fetch a token from the tokens service, throwing an actionable error if not found.
 * @param {string} name - Token identifier
 * @returns {string} The resolved token string
 * @throws {Error} When token is not found or empty
 */
export function requireSecret(name) {
  const val = getSecret(name);
  if (!val) {
    throw new Error(
      `[tokens-sdk] Token '${name}' not found in tokens service.\n` +
      `  👉 To set this token, run: tokens set ${name} <value>\n` +
      `  👉 To list available tokens, run: tokens list`
    );
  }
  return val;
}

/**
 * Fetch multiple secrets at once into a key-value object.
 * @param {string[]} names - Array of token names
 * @returns {Record<string, string|null>} Map of token names to resolved values
 */
export function getSecrets(names) {
  const result = {};
  if (Array.isArray(names)) {
    for (const n of names) {
      result[n] = getSecret(n);
    }
  }
  return result;
}

/**
 * Fetch multiple required secrets at once, throwing if any are missing.
 * @param {string[]} names - Array of token names
 * @returns {Record<string, string>} Map of token names to values
 */
export function requireSecrets(names) {
  const result = {};
  if (Array.isArray(names)) {
    for (const n of names) {
      result[n] = requireSecret(n);
    }
  }
  return result;
}

/**
 * Clear the in-memory secret cache.
 */
export function clearCache() {
  _cache.clear();
}

/**
 * Manually set or override a secret in the in-memory cache (useful for mock testing).
 * @param {string} name
 * @param {string} value
 */
export function setCachedSecret(name, value) {
  _cache.set(name, value);
}

// ── Convenience Pre-wired Getters ─────────────────────────────────────────────

export const getWorkerApiKey = () => requireSecret('WORKER_API_KEY');
export const getGeminiApiKey = () => requireSecret('GEMINI_API_KEY');
export const getOpenAiApiKey = () => requireSecret('OPENAI_API_KEY');
export const getCloudflareWranglerToken = () => requireSecret('CLOUDFLARE_WRANGLER_API_TOKEN');
export const getCloudflareAccountId = () => requireSecret('CLOUDFLARE_ACCOUNT_ID');
export const getCloudflareAiGatewayToken = () => requireSecret('CLOUDFLARE_AI_GATEWAY_TOKEN');
export const getCloudflareSecretStoreAdminToken = () => requireSecret('CLOUDFLARE_SECRET_STORE_ADMIN_TOKEN');
export const getAnthropicApiKey = () => requireSecret('ANTHROPIC_API_KEY');
export const getGithubToken = () => requireSecret('GITHUB_TOKEN');
export const getClerkSecretKey = () => requireSecret('CLERK_SECRET_KEY');
export const getClerkPublicKey = () => requireSecret('CLERK_PUBLIC_KEY');
export const getHassioToken = () => requireSecret('HASSIO_TOKEN');
export const getHassioUri = () => requireSecret('HASSIO_URI');

export default {
  getSecret,
  requireSecret,
  getSecrets,
  requireSecrets,
  clearCache,
  setCachedSecret,
  resolveTokensBinary,
  getWorkerApiKey,
  getGeminiApiKey,
  getOpenAiApiKey,
  getCloudflareWranglerToken,
  getCloudflareAccountId,
  getCloudflareAiGatewayToken,
  getCloudflareSecretStoreAdminToken,
  getAnthropicApiKey,
  getGithubToken,
  getClerkSecretKey,
  getClerkPublicKey,
  getHassioToken,
  getHassioUri,
};
