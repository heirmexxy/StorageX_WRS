// Settings from the environment (.env is loaded by systemd's EnvironmentFile in production, or by loadEnvFile here).
import fs from 'node:fs';

if (!process.env.NO_ENV_FILE && fs.existsSync('.env')) {
  try { process.loadEnvFile('.env'); } catch { /* malformed .env: fall through to defaults and fail below */ }
}

const env = (k: string, d = '') => (process.env[k] ?? d).trim();
const production = env('NODE_ENV') === 'production';

export const config = {
  production,
  baseUrl: env('BASE_URL', 'http://localhost:3200'),
  port: Number(env('PORT', '3200')),
  bind: env('HOST_BIND', '127.0.0.1'),
  databaseUrl: env('DATABASE_URL', 'postgres://storagex:devpass@127.0.0.1:5432/storagex_dev'),
  secret: env('APP_SECRET', production ? '' : 'dev-only-secret-change-me-0123456789abcdef0123456789abcdef'),
  sessionIdleMinutes: Number(env('SESSION_IDLE_MINUTES', '60')),
  sessionMaxHours: Number(env('SESSION_MAX_HOURS', '12')),
  backupDir: env('BACKUP_DIR', 'data/backups'),
  uploadsDir: env('UPLOADS_DIR', 'data/uploads'),
  // SMS through Termii (the same account ComboTrader uses). Without a key, codes are only logged (never in production).
  termiiKey: env('TERMII_API_KEY'),
  termiiSender: env('TERMII_SENDER_ID', 'Kitovu'),
  // Optional paid identity lookup. 'none' = Kitovu's own maker-checker review only.
  kycProvider: env('KYC_PROVIDER', 'none'),
  // ID photos and selfies are deleted this many days after a review decision (the decision and hashes remain).
  idDocRetentionDays: Number(env('ID_DOC_RETENTION_DAYS', '365')),
};

if (production && !/^[0-9a-f]{64}$/i.test(config.secret)) {
  throw new Error('APP_SECRET must be 64 hex characters in production (openssl rand -hex 32).');
}
