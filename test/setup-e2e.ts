import 'dotenv/config';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.AUTH_ALLOW_FAKE_GOOGLE = 'true';
process.env.CORS_ORIGINS = 'http://localhost:4200,http://localhost:4300';
// El e2e no usa Redis aunque exista en el entorno.
delete process.env.REDIS_URL;
process.env.THROTTLE_SCALE = '1000';
process.env.CMS_WEBHOOK_SECRET = 'e2e-cms-webhook-secret-0123456789abcdef';
process.env.PAYMENT_GATEWAY_MODE = 'fake';
process.env.BILLING_MODE = 'fake';
