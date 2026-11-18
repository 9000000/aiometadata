// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import consola from 'consola';
import { LRUCache } from 'lru-cache';
import { KEEP_ALIVE } from './httpClient';

const { request, Agent, ProxyAgent }: any = require('undici');

const logger = consola.withTag('Gemini');
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const PROXY_CONNECTIONS = 25;
const CIRCUIT_BREAKER_MAX_MODELS = 64;
const CIRCUIT_BREAKER_FAILURE_THRESHOLD = 2;
const CIRCUIT_BREAKER_COOLDOWN_MS = 60_000;
const TIMEOUT_ERROR_CODES = new Set([
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'ETIMEDOUT',
]);

interface CircuitBreakerState {
  consecutiveFailures: number;
  openUntil: number;
}

const modelCircuitBreaker = new LRUCache<string, CircuitBreakerState>({
  max: CIRCUIT_BREAKER_MAX_MODELS,
});

function isCircuitBreakerFailure(statusCode?: number, error?: any): boolean {
  if (statusCode === 502 || statusCode === 503 || statusCode === 504) return true;
  const code = error?.code || error?.cause?.code;
  if (code && TIMEOUT_ERROR_CODES.has(String(code))) return true;
  if (error?.name === 'TimeoutError' || error?.cause?.name === 'TimeoutError') return true;
  return false;
}

function recordModelFailure(model: string): void {
  const prev = modelCircuitBreaker.get(model);
  const now = Date.now();
  const consecutiveFailures = (prev?.consecutiveFailures || 0) + 1;
  const wasOpen = Boolean(prev && now < prev.openUntil);
  const openUntil = consecutiveFailures >= CIRCUIT_BREAKER_FAILURE_THRESHOLD
    ? now + CIRCUIT_BREAKER_COOLDOWN_MS
    : 0;
  modelCircuitBreaker.set(model, { consecutiveFailures, openUntil });
  if (openUntil > 0 && !wasOpen) {
    logger.warn(`Gemini circuit breaker opened for ${model} after ${consecutiveFailures} consecutive failures (cooldown 60s)`);
  }
}

interface GenerateContentOptions {
  apiKey: string;
  model: string;
  prompt: string;
  systemPrompt?: string;
  useGrounding?: boolean;
  timeout?: number;
}

interface GenerateContentResult {
  text: string | null;
  candidates: any[];
  groundingMetadata: any | null;
  promptFeedback: any | null;
  finishReason: string | null;
  safetyRatings: any | null;
}

const getGeminiProxyUrl = (): string | null => {
  const geminiProxy = process.env.GEMINI_HTTPS_PROXY ?? process.env.GEMINI_HTTP_PROXY;
  if (geminiProxy) {
    try {
      return new URL(geminiProxy).toString();
    } catch (error: any) {
      console.warn('Invalid Gemini proxy URL:', geminiProxy);
    }
  }
  const globalProxy = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;
  if (globalProxy) {
    try {
      return new URL(globalProxy).toString();
    } catch (error: any) {
      console.warn('Invalid global proxy URL:', globalProxy);
    }
  }
  return null;
};

const createGeminiDispatcher = (): any => {
  const proxyUrl = getGeminiProxyUrl();
  if (proxyUrl) {
    return new ProxyAgent({ uri: proxyUrl, allowH2: false, connections: PROXY_CONNECTIONS, ...KEEP_ALIVE });
  }
  return new Agent({
    allowH2: false,
    keepAliveTimeout: 30000,
    keepAliveMaxTimeout: 60000,
    connections: 50,
    pipelining: 1,
  });
};

const geminiDispatcher: any = createGeminiDispatcher();

async function generateContent({ apiKey, model, prompt, systemPrompt, useGrounding = false, timeout = 30000 }: GenerateContentOptions): Promise<GenerateContentResult> {
  const breakerState = modelCircuitBreaker.get(model);
  if (breakerState && Date.now() < breakerState.openUntil) {
    const breakerError: any = new Error(`Gemini circuit breaker open for ${model}`);
    breakerError.code = 'CIRCUIT_BREAKER_OPEN';
    throw breakerError;
  }

  const url = `${GEMINI_BASE_URL}/models/${model}:generateContent`;
  const startTime = Date.now();

  const body: any = {
    contents: [
      {
        parts: [{ text: prompt }]
      }
    ]
  };

  if (systemPrompt) {
    body.system_instruction = { parts: [{ text: systemPrompt }] };
  }

  if (useGrounding) {
    body.tools = [{ google_search: {} }];
  }

  const headersTimeout = timeout;
  const bodyTimeout = Math.min(timeout, 30000);

  try {
    const { statusCode, body: responseBody } = await request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify(body),
      dispatcher: geminiDispatcher,
      headersTimeout,
      bodyTimeout,
    });

    const rawText = await responseBody.text();
    let data: any = null;
    if (rawText) {
      try {
        data = JSON.parse(rawText);
      } catch {
        data = null;
      }
    }
    const responseTime = Date.now() - startTime;

    if (statusCode !== 200) {
      const requestTracker: any = require('../lib/requestTracker');
      requestTracker.trackProviderCall('gemini', responseTime, false);
      if (isCircuitBreakerFailure(statusCode)) {
        recordModelFailure(model);
      }

      const errorMessage = data?.error?.message || `HTTP ${statusCode}`;
      const error: any = new Error(`Gemini API error: ${errorMessage}`);
      error.statusCode = statusCode;
      error.response = data;
      throw error;
    }

    modelCircuitBreaker.delete(model);
    const requestTracker: any = require('../lib/requestTracker');
    requestTracker.trackProviderCall('gemini', responseTime, true);

    const candidate = data?.candidates?.[0];
    const text = candidate?.content?.parts?.[0]?.text || null;
    const groundingMetadata = candidate?.groundingMetadata || null;

    return {
      text,
      candidates: data?.candidates || [],
      groundingMetadata,
      promptFeedback: data?.promptFeedback || null,
      finishReason: candidate?.finishReason || null,
      safetyRatings: candidate?.safetyRatings || null,
    };
  } catch (error: any) {
    if (error?.code === 'CIRCUIT_BREAKER_OPEN') {
      throw error;
    }

    const responseTime = Date.now() - startTime;

    if (!error.statusCode) {
      const requestTracker: any = require('../lib/requestTracker');
      requestTracker.trackProviderCall('gemini', responseTime, false);
      if (isCircuitBreakerFailure(undefined, error)) {
        recordModelFailure(model);
      }
    }

    throw error;
  }
}

function getAgentStats(): any {
  return geminiDispatcher.stats;
}

async function closeAgent(): Promise<void> {
  await geminiDispatcher.close();
}

export { generateContent, getAgentStats, closeAgent };
module.exports = { generateContent, getAgentStats, closeAgent };
