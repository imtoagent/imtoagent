// ================================================================
// Circuit Breaker — Provider failure isolation
// ================================================================
// Three states: CLOSED (normal) → OPEN (tripped) → HALF_OPEN (probing)
// Usage: wrap provider requests, record success/failure
// ================================================================

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerConfig {
  failureThreshold?: number;    // failures before opening (default: 3)
  recoveryTimeout?: number;     // ms to wait before half-open (default: 60000)
  halfOpenMaxRequests?: number; // max test requests in half-open (default: 1)
}

export interface CircuitStats {
  state: CircuitState;
  failures: number;
  lastFailureTime: number;
  lastSuccessTime: number;
  halfOpenRequests: number;
  totalTrips: number;
}

export class CircuitBreaker {
  readonly name: string;
  private config: Required<CircuitBreakerConfig>;
  private _state: CircuitState = 'CLOSED';
  private failures = 0;
  private lastFailureTime = 0;
  private lastSuccessTime = 0;
  private halfOpenRequests = 0;
  private totalTrips = 0;

  constructor(name: string, config: CircuitBreakerConfig = {}) {
    this.name = name;
    this.config = {
      failureThreshold: config.failureThreshold || 3,
      recoveryTimeout: config.recoveryTimeout || 60_000,
      halfOpenMaxRequests: config.halfOpenMaxRequests || 1,
    };
  }

  get state(): CircuitState {
    // Auto-transition from OPEN to HALF_OPEN after recovery timeout
    if (this._state === 'OPEN') {
      const elapsed = Date.now() - this.lastFailureTime;
      if (elapsed >= this.config.recoveryTimeout) {
        this._state = 'HALF_OPEN';
        this.halfOpenRequests = 0;
        console.log(`[CircuitBreaker] ${this.name}: OPEN → HALF_OPEN (recovery timeout elapsed)`);
      }
    }
    return this._state;
  }

  /**
   * Check if a request is allowed through the breaker.
   */
  canRequest(): boolean {
    const state = this.state; // triggers auto-transition check

    switch (state) {
      case 'CLOSED':
        return true;
      case 'OPEN':
        return false;
      case 'HALF_OPEN':
        return this.halfOpenRequests < this.config.halfOpenMaxRequests;
    }
  }

  /**
   * Record a successful request.
   */
  recordSuccess(): void {
    this.lastSuccessTime = Date.now();

    if (this._state === 'HALF_OPEN') {
      // Success in half-open → back to closed
      this._state = 'CLOSED';
      this.failures = 0;
      this.halfOpenRequests = 0;
      console.log(`[CircuitBreaker] ${this.name}: HALF_OPEN → CLOSED (recovered)`);
    } else if (this._state === 'CLOSED') {
      // Reset failure count on success in closed state
      this.failures = 0;
    }
  }

  /**
   * Record a failed request.
   */
  recordFailure(): void {
    this.failures++;
    this.lastFailureTime = Date.now();

    if (this._state === 'HALF_OPEN') {
      // Failure in half-open → back to open
      this._state = 'OPEN';
      this.totalTrips++;
      console.log(`[CircuitBreaker] ${this.name}: HALF_OPEN → OPEN (recovery failed)`);
    } else if (this._state === 'CLOSED' && this.failures >= this.config.failureThreshold) {
      // Threshold reached → open
      this._state = 'OPEN';
      this.totalTrips++;
      console.log(`[CircuitBreaker] ${this.name}: CLOSED → OPEN (threshold reached: ${this.failures})`);
    }
  }

  /**
   * Get current stats (for health reporting).
   */
  getStats(): CircuitStats {
    return {
      state: this.state,
      failures: this.failures,
      lastFailureTime: this.lastFailureTime,
      lastSuccessTime: this.lastSuccessTime,
      halfOpenRequests: this.halfOpenRequests,
      totalTrips: this.totalTrips,
    };
  }

  /**
   * Reset to closed state (manual override).
   */
  reset(): void {
    this._state = 'CLOSED';
    this.failures = 0;
    this.halfOpenRequests = 0;
    console.log(`[CircuitBreaker] ${this.name}: manually reset to CLOSED`);
  }
}

// ================================================================
// Multi-breaker manager for multiple providers
// ================================================================

export class CircuitBreakerManager {
  private breakers = new Map<string, CircuitBreaker>();

  get(name: string): CircuitBreaker | undefined {
    return this.breakers.get(name);
  }

  create(name: string, config?: CircuitBreakerConfig): CircuitBreaker {
    const breaker = new CircuitBreaker(name, config);
    this.breakers.set(name, breaker);
    return breaker;
  }

  /**
   * Find the first available (non-OPEN) breaker.
   * Returns null if all are open.
   */
  findAvailable(names: string[]): string | null {
    for (const name of names) {
      const breaker = this.breakers.get(name);
      if (breaker && breaker.canRequest()) {
        return name;
      }
    }
    return null;
  }

  /**
   * Get health status for all breakers.
   */
  healthStatus(): Record<string, CircuitStats> {
    const status: Record<string, CircuitStats> = {};
    for (const [name, breaker] of this.breakers) {
      status[name] = breaker.getStats();
    }
    return status;
  }
}
