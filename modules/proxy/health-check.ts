// ================================================================
// Provider Health Check — periodic lightweight probes
// ================================================================
// Sends a minimal request to each provider at configured intervals
// Reports health status for /health endpoint
// ================================================================

import * as http from 'http';

export interface ProviderHealthConfig {
  name: string;
  baseUrl: string;
  apiKey: string;
  format: 'openai' | 'anthropic';
  interval?: number;       // seconds between checks (default: 300)
  timeout?: number;        // request timeout ms (default: 10000)
}

export interface ProviderHealthStatus {
  name: string;
  healthy: boolean;
  latencyMs?: number;
  lastChecked?: number;
  lastError?: string;
  consecutiveFailures: number;
}

export class ProviderHealthChecker {
  private config: ProviderHealthConfig;
  private _status: ProviderHealthStatus;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(config: ProviderHealthConfig) {
    this.config = config;
    this._status = {
      name: config.name,
      healthy: true,
      consecutiveFailures: 0,
    };
  }

  get status(): ProviderHealthStatus {
    return { ...this._status };
  }

  /**
   * Start periodic health checks.
   */
  start(): void {
    if (this.timer) return;

    const intervalMs = (this.config.interval || 300) * 1000;
    this.timer = setInterval(() => this.check(), intervalMs);

    // Do initial check after a short delay
    setTimeout(() => this.check(), 5000);
    console.log(`[HealthCheck] ${this.config.name}: started (interval=${this.config.interval || 300}s)`);
  }

  /**
   * Stop periodic checks.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log(`[HealthCheck] ${this.config.name}: stopped`);
    }
  }

  /**
   * Run a single health check.
   */
  async check(): Promise<boolean> {
    const startTime = Date.now();

    try {
      let healthy = false;

      if (this.config.format === 'openai') {
        healthy = await this.checkOpenAI();
      } else {
        healthy = await this.checkAnthropic();
      }

      const latency = Date.now() - startTime;
      this._status.healthy = healthy;
      this._status.latencyMs = latency;
      this._status.lastChecked = Date.now();

      if (healthy) {
        this._status.consecutiveFailures = 0;
        this._status.lastError = undefined;
      } else {
        this._status.consecutiveFailures++;
        this._status.lastError = 'Health probe returned unexpected response';
      }

      return healthy;
    } catch (err: unknown) {
      this._status.healthy = false;
      this._status.latencyMs = Date.now() - startTime;
      this._status.lastChecked = Date.now();
      this._status.consecutiveFailures++;
      this._status.lastError = err.message || 'Unknown error';
      return false;
    }
  }

  private checkOpenAI(): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        const url = new URL(this.config.baseUrl);
        const isHttps = url.protocol === 'https:';
        const lib = isHttps ? require('https') : require('http');

        const req = lib.get(`${this.config.baseUrl}/models`, {
          headers: {
            'Authorization': `Bearer ${this.config.apiKey}`,
          },
          timeout: this.config.timeout || 10000,
        }, (res: http.IncomingMessage) => {
          // 200 or 4xx (some providers return 404 for /models but are still alive)
          resolve(res.statusCode !== undefined && res.statusCode < 500);
          res.resume();
        });

        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
      } catch {
        resolve(false);
      }
    });
  }

  private checkAnthropic(): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        const url = new URL(this.config.baseUrl);
        const isHttps = url.protocol === 'https:';
        const lib = isHttps ? require('https') : require('http');

        const body = JSON.stringify({ max_tokens: 1 });
        const reqPath = url.pathname.endsWith('/') ? url.pathname : url.pathname + '/';

        const req = lib.request(`${this.config.baseUrl}/v1/messages`, {
          method: 'POST',
          headers: {
            'x-api-key': this.config.apiKey,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
          },
          timeout: this.config.timeout || 10000,
        }, (res: http.IncomingMessage) => {
          // 400 is OK (missing model param) — means the endpoint is alive
          // 401/403 means auth issue but endpoint is alive
          // 5xx means truly down
          resolve(res.statusCode !== undefined && res.statusCode < 500);
          res.resume();
        });

        req.write(body);
        req.end();

        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
      } catch {
        resolve(false);
      }
    });
  }
}

// ================================================================
// Health endpoint handler
// ================================================================

export function createHealthHandler(
  checker: ProviderHealthChecker | null,
  proxyPort: number
): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  return (req: http.IncomingMessage, res: http.ServerResponse) => {
    if (req.method !== 'GET') {
      res.writeHead(405);
      res.end('Method not allowed');
      return;
    }

    const status: Record<string, unknown> = {
      status: 'ok',
      uptime: process.uptime(),
      pid: process.pid,
      proxyPort,
    };

    if (checker) {
      status.provider = checker.status;
      if (!checker.status.healthy) {
        status.status = 'degraded';
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status, null, 2));
  };
}
