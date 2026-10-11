export interface RelayConfig {
  readonly port: number;
  readonly host: string;
  /** SQLite file path, or ":memory:". */
  readonly dbPath: string;
  readonly maxMessageBytes: number;
  /** Token bucket per connection: sustained messages/second and burst size. */
  readonly rateLimit: { readonly perSecond: number; readonly burst: number };
  /** Replicas unseen for longer than this no longer hold back tombstone stability. */
  readonly replicaLeaseMs: number;
  readonly corsOrigin: string | boolean;
  readonly logLevel: string;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): RelayConfig {
  return {
    port: Number(env.PORT ?? 8787),
    host: env.HOST ?? '0.0.0.0',
    dbPath: env.DB_PATH ?? 'collabpad.sqlite',
    maxMessageBytes: Number(env.MAX_MESSAGE_BYTES ?? 256 * 1024),
    rateLimit: {
      perSecond: Number(env.RATE_LIMIT_PER_SECOND ?? 50),
      burst: Number(env.RATE_LIMIT_BURST ?? 200),
    },
    replicaLeaseMs: Number(env.REPLICA_LEASE_MS ?? 7 * 24 * 60 * 60 * 1000),
    corsOrigin: env.CORS_ORIGIN ?? true,
    logLevel: env.LOG_LEVEL ?? 'info',
  };
}
