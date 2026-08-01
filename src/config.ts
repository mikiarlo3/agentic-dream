export interface DreamConfig {
  port: number;
  storeDir: string;
  accessToken: string | null; // gates /api/* and /ui when set
  modelKey: string | null; // operator-supplied key for background jobs
  upstreamBaseUrl: string;
  windowBudget: number; // estimated tokens
  extractModel: string;
  pressModel: string;
  /** Raw tail may exceed its budget by this fraction before a press fires. */
  pressHysteresis: number;
  /** Turn-pairs per pressed segment. */
  segmentTurnPairs: number;
  /** ms of conversation idle time before consolidation runs. */
  idleConsolidateMs: number;
  /** ms between periodic sweeps (decay, molt, promote). */
  sweepIntervalMs: number;
  maxBodyBytes: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DreamConfig {
  return {
    port: parseInt(env.PORT ?? '8082', 10),
    storeDir: env.DREAM_STORE_DIR ?? 'dream-store',
    accessToken: env.DREAM_ACCESS_TOKEN || null,
    modelKey: env.DREAM_MODEL_KEY || null,
    upstreamBaseUrl: (env.UPSTREAM_BASE_URL ?? 'https://api.anthropic.com').replace(/\/$/, ''),
    windowBudget: parseInt(env.DREAM_WINDOW_BUDGET ?? '30000', 10),
    extractModel: env.DREAM_EXTRACT_MODEL ?? 'claude-haiku-4-5-20251001',
    pressModel: env.DREAM_PRESS_MODEL ?? 'claude-haiku-4-5-20251001',
    pressHysteresis: parseFloat(env.DREAM_PRESS_HYSTERESIS ?? '0.25'),
    segmentTurnPairs: parseInt(env.DREAM_SEGMENT_TURN_PAIRS ?? '8', 10),
    idleConsolidateMs: parseInt(env.DREAM_IDLE_CONSOLIDATE_MS ?? String(5 * 60 * 1000), 10),
    sweepIntervalMs: parseInt(env.DREAM_SWEEP_INTERVAL_MS ?? String(60 * 60 * 1000), 10),
    maxBodyBytes: parseInt(env.DREAM_MAX_BODY_BYTES ?? String(20 * 1024 * 1024), 10),
  };
}
