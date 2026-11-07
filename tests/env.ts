// Imported first by tests/run.ts so these are set before any module reads its configuration.
process.env.NO_AUTOSTART = '1';
process.env.NO_ENV_FILE = '1';
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://storagex:devpass@127.0.0.1:5432/storagex_test';
process.env.BASE_URL = 'http://localhost:3299';
process.env.APP_SECRET = '0'.repeat(64);
process.env.UPLOADS_DIR = `/tmp/storagex-test-uploads-${process.pid}`;
