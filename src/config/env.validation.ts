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
  /** Atributo `Secure` de la cookie del refresh token. Solo se puede apagar fuera de producción (HTTP local). */
  REFRESH_COOKIE_SECURE: Joi.boolean()
    .default(true)
    .when('NODE_ENV', { is: 'production', then: Joi.valid(true) }),
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
  /**
   * Correo saliente. `log` solo escribe en el log (desarrollo y pruebas; muestra los enlaces con
   * tokens); producción exige `smtp`.
   */
  MAIL_DRIVER: Joi.string().when('NODE_ENV', {
    is: 'production',
    then: Joi.valid('smtp').required(),
    otherwise: Joi.valid('log', 'smtp').default('log'),
  }),
  /** Servidor SMTP; con Google Workspace, `smtp-relay.gmail.com` (587, STARTTLS) o `smtp.gmail.com`. */
  SMTP_HOST: Joi.string()
    .hostname()
    .when('MAIL_DRIVER', {
      is: 'smtp',
      then: Joi.required(),
      otherwise: Joi.allow('').default(''),
    }),
  SMTP_PORT: Joi.number().port().default(587),
  /** TLS implícito (puerto 465). En 587 se deja en `false` y se usa STARTTLS. */
  SMTP_SECURE: Joi.boolean().default(false),
  /** Exige STARTTLS cuando no hay TLS implícito. Solo se apaga en desarrollo (p. ej. Mailpit). */
  SMTP_REQUIRE_TLS: Joi.boolean()
    .default(true)
    .when('NODE_ENV', { is: 'production', then: Joi.valid(true) }),
  /** Credenciales opcionales (el relay de Google puede autorizar por IP). Van juntas. */
  SMTP_USER: Joi.string().allow('').default(''),
  SMTP_PASSWORD: Joi.string()
    .allow('')
    .default('')
    .when('SMTP_USER', {
      is: Joi.string().min(1),
      then: Joi.string().min(1).required(),
    }),
  /** Remitente, p. ej. `Desértica <reservas@desertica.pe>`. */
  MAIL_FROM: Joi.string().when('MAIL_DRIVER', {
    is: 'smtp',
    then: Joi.required(),
    otherwise: Joi.allow('').default(''),
  }),
  /** Dirección a la que responden los clientes (opcional). */
  MAIL_REPLY_TO: Joi.string().email().allow('').default(''),
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
  REFRESH_COOKIE_SECURE: boolean;
  AUTH_ALLOW_FAKE_GOOGLE: boolean;
  TURNSTILE_SECRET_KEY: string;
  STAFF_NOTIFY_EMAIL: string;
  MAIL_DRIVER: 'log' | 'smtp';
  SMTP_HOST: string;
  SMTP_PORT: number;
  SMTP_SECURE: boolean;
  SMTP_REQUIRE_TLS: boolean;
  SMTP_USER: string;
  SMTP_PASSWORD: string;
  MAIL_FROM: string;
  MAIL_REPLY_TO: string;
  PAYMENT_WINDOW_MINUTES: number;
  EXPIRY_SWEEP_SECONDS: number;
  CMS_URL: string;
  CMS_API_TOKEN: string;
  CMS_CACHE_TTL_SECONDS: number;
}
