import 'dotenv/config';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.AUTH_ALLOW_FAKE_GOOGLE = 'true';
process.env.CORS_ORIGINS = 'http://localhost:4200,http://localhost:4300';
// El e2e no usa Redis aunque exista en el entorno.
delete process.env.REDIS_URL;
