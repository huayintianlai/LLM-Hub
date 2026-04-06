function now() {
  return Date.now();
}

function computeAverageLatency(current, sample) {
  if (!current || current <= 0) {
    return sample;
  }
  return Number((current * 0.7 + sample * 0.3).toFixed(2));
}

export class UpstreamManager {
  constructor(config, database, logger) {
    this.config = config;
    this.database = database;
    this.logger = logger;
    this.states = new Map();

    for (const upstream of config.upstreams) {
      this.states.set(upstream.id, {
        upstream_id: upstream.id,
        circuit_state: 'closed',
        consecutive_failures: 0,
        cooldown_until: 0,
        last_failure_at: null,
        last_success_at: null,
        average_latency_ms: 0,
        success_count: 0,
        failure_count: 0,
        last_error: null,
        updated_at: now(),
      });
    }
  }

  getUpstream(id) {
    return this.config.upstreams.find((item) => item.id === id) || null;
  }

  getState(id) {
    return this.states.get(id);
  }

  snapshot() {
    return this.config.upstreams.map((upstream) => {
      const state = this.getState(upstream.id);
      return {
        id: upstream.id,
        name: upstream.name,
        priority: upstream.priority,
        capabilities: upstream.capabilities,
        cost: upstream.cost,
        ...state,
        in_cooldown: Boolean(state?.cooldown_until && state.cooldown_until > now()),
      };
    });
  }

  isAvailable(id) {
    const state = this.getState(id);
    if (!state) {
      return false;
    }
    if (!state.cooldown_until) {
      return true;
    }
    if (state.cooldown_until <= now()) {
      if (state.circuit_state === 'open') {
        state.circuit_state = 'half_open';
        state.updated_at = now();
        this.database?.recordUpstreamState(state);
      }
      return true;
    }
    return false;
  }

  getOrderedUpstreams(strategy = 'balanced') {
    const active = [];
    const cooling = [];

    for (const upstream of this.config.upstreams) {
      const state = this.getState(upstream.id);
      const item = { upstream, state, score: this.score(upstream, state, strategy) };
      if (this.isAvailable(upstream.id)) {
        active.push(item);
      } else {
        cooling.push(item);
      }
    }

    const sorter = (left, right) => left.score - right.score;
    active.sort(sorter);
    cooling.sort(sorter);
    return [...active, ...cooling].map((item) => item.upstream.id);
  }

  score(upstream, state, strategy) {
    const latency = state.average_latency_ms || 10000;
    const promptCost = Number(upstream.cost?.per_1k_prompt || 0);
    const completionCost = Number(upstream.cost?.per_1k_completion || 0);
    const totalCost = promptCost + completionCost;
    const priority = Number(upstream.priority || 100);
    const failurePenalty = (state.consecutive_failures || 0) * 5000;

    if (strategy === 'latency-first') {
      return latency + totalCost * 50 + priority * 20 + failurePenalty;
    }
    if (strategy === 'cost-first') {
      return totalCost * 1000 + latency * 0.2 + priority * 10 + failurePenalty;
    }
    return priority * 100 + latency * 0.5 + totalCost * 200 + failurePenalty;
  }

  registerSuccess(id, latencyMs, statusCode) {
    const state = this.getState(id);
    if (!state) {
      return;
    }
    state.circuit_state = 'closed';
    state.consecutive_failures = 0;
    state.cooldown_until = 0;
    state.last_success_at = now();
    state.average_latency_ms = computeAverageLatency(state.average_latency_ms, latencyMs);
    state.success_count += 1;
    state.last_error = null;
    state.last_status_code = statusCode || null;
    state.updated_at = now();
    this.database?.recordUpstreamState(state);
  }

  registerFailure(id, errorMessage) {
    const state = this.getState(id);
    if (!state) {
      return;
    }
    const breaker = this.config.failover?.circuit_breaker || {};
    const threshold = Number(breaker.failure_threshold || 3);
    const initialCooldownMs = Number(breaker.initial_cooldown || 60) * 1000;
    const maxCooldownMs = Number(breaker.max_cooldown || 1800) * 1000;
    const exponential = breaker.exponential_backoff !== false;

    state.failure_count += 1;
    state.consecutive_failures += 1;
    state.last_failure_at = now();
    state.last_error = errorMessage;
    state.updated_at = now();

    if (state.consecutive_failures >= threshold) {
      const exponent = exponential ? Math.max(0, state.consecutive_failures - threshold) : 0;
      const cooldownMs = Math.min(maxCooldownMs, initialCooldownMs * 2 ** exponent);
      state.cooldown_until = now() + cooldownMs;
      state.circuit_state = 'open';
      this.logger?.warn('upstream opened by circuit breaker', {
        upstream_id: id,
        cooldown_ms: cooldownMs,
        error: errorMessage,
      });
    }

    this.database?.recordUpstreamState(state);
  }
}
