import Joi from 'joi';

/**
 * Esquema de las variables de entorno. La app no arranca si falta una
 * obligatoria o si alguna tiene un valor inválido.
 */
export const envSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'test', 'production')
    .default('development'),
  PORT: Joi.number().port().default(3000),
  LOG_LEVEL: Joi.string()
    .valid('fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent')
    .default('info'),

  DATABASE_URL: Joi.string()
    .uri({ scheme: ['postgres', 'postgresql'] })
    .required(),
  /** Opcional. Sin Redis se usan almacenes en memoria (solo válidos con una instancia). */
  REDIS_URL: Joi.string()
    .uri({ scheme: ['redis', 'rediss'] })
    .optional(),

  /** Orígenes CORS permitidos, separados por coma. Obligatorio en producción. */
  CORS_ORIGINS: Joi.string().when('NODE_ENV', {
    is: 'production',
    then: Joi.string().min(1).required(),
    otherwise: Joi.string()
      .allow('')
      .default('http://localhost:4200,http://localhost:4300'),
  }),
  /** Saltos de proxy confiables para resolver la IP real (0 = ninguno). */
  TRUST_PROXY: Joi.number().integer().min(0).default(0),
  /** Límite global por IP: peticiones por ventana. */
  THROTTLE_LIMIT: Joi.number().integer().min(1).default(120),
  THROTTLE_TTL_MS: Joi.number().integer().min(1000).default(60_000),

  /** Base pública de los enlaces que se envían por correo (web del cliente). */
  PUBLIC_WEB_URL: Joi.string()
    .uri()
    .when('NODE_ENV', {
      is: 'production',
      then: Joi.required(),
      otherwise: Joi.string().default('http://localhost:4200'),
    }),

  // Auth del staff (M2)
  GOOGLE_CLIENT_ID: Joi.string().when('NODE_ENV', {
    is: 'production',
    then: Joi.required(),
    otherwise: Joi.string().allow('').default(''),
  }),
  ALLOWED_EMAIL_DOMAIN: Joi.string().default('desertica.pe'),
  JWT_ACCESS_SECRET: Joi.string()
    .min(32)
    .when('NODE_ENV', {
      is: 'production',
      then: Joi.required(),
      otherwise: Joi.string().default(
        'dev-only-access-secret-change-me-0123456789',
      ),
    }),
  JWT_ACCESS_TTL_SECONDS: Joi.number().integer().min(60).default(900),
  REFRESH_TTL_DAYS: Joi.number().integer().min(1).default(30),
  /** Solo desarrollo y pruebas: acepta un ID token falso con este prefijo. */
  AUTH_ALLOW_FAKE_GOOGLE: Joi.boolean()
    .default(false)
    .when('NODE_ENV', { is: 'production', then: Joi.valid(false) }),

  /** Cloudflare Turnstile. Sin clave no se verifica el captcha (desarrollo). */
  TURNSTILE_SECRET_KEY: Joi.string().when('NODE_ENV', {
    is: 'production',
    then: Joi.required(),
    otherwise: Joi.string().allow('').default(''),
  }),
  /** Destino de los avisos internos (contacto, reclamos). Opcional. */
  STAFF_NOTIFY_EMAIL: Joi.string().email().allow('').default(''),
  /** Minutos para pagar una reserva web antes de que se libere el cupo. */
  PAYMENT_WINDOW_MINUTES: Joi.number().integer().min(5).max(1440).default(30),
  /** Cada cuántos segundos corre el barrido de bloqueos vencidos (0 = apagado). */
  EXPIRY_SWEEP_SECONDS: Joi.number().integer().min(0).default(60),

  // CMS (M3)
  CMS_URL: Joi.string().uri().default('http://localhost:1337'),
  CMS_API_TOKEN: Joi.string().allow('').default(''),
  CMS_CACHE_TTL_SECONDS: Joi.number().integer().min(0).default(300),
});

export interface EnvVars {
  NODE_ENV: 'development' | 'test' | 'production';
  PORT: number;
  LOG_LEVEL: string;
  DATABASE_URL: string;
  REDIS_URL?: string;
  CORS_ORIGINS: string;
  TRUST_PROXY: number;
  THROTTLE_LIMIT: number;
  THROTTLE_TTL_MS: number;
  PUBLIC_WEB_URL: string;
  GOOGLE_CLIENT_ID: string;
  ALLOWED_EMAIL_DOMAIN: string;
  JWT_ACCESS_SECRET: string;
  JWT_ACCESS_TTL_SECONDS: number;
  REFRESH_TTL_DAYS: number;
  AUTH_ALLOW_FAKE_GOOGLE: boolean;
  TURNSTILE_SECRET_KEY: string;
  STAFF_NOTIFY_EMAIL: string;
  PAYMENT_WINDOW_MINUTES: number;
  EXPIRY_SWEEP_SECONDS: number;
  CMS_URL: string;
  CMS_API_TOKEN: string;
  CMS_CACHE_TTL_SECONDS: number;
}
