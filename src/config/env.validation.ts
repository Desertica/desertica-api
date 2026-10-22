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
  /** Pool de conexiones a Postgres (por instancia). */
  DB_POOL_MAX: Joi.number().integer().min(1).max(200).default(20),
  /** Espera máxima por una conexión del pool; vencida, la petición responde 503. */
  DB_CONNECTION_TIMEOUT_MS: Joi.number().integer().min(100).default(5000),
  /** Tope de una sentencia SQL (statement_timeout). */
  DB_STATEMENT_TIMEOUT_MS: Joi.number().integer().min(1000).default(30_000),
  /** Cierra la sesión que deja una transacción abierta sin actividad (idle_in_transaction_session_timeout). */
  DB_IDLE_IN_TX_TIMEOUT_MS: Joi.number().integer().min(1000).default(30_000),
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
  /**
   * Saltos de proxy confiables para resolver la IP real (0 = ninguno). En producción es explícito:
   * con el valor por defecto todos los clientes compartirían la IP del proxy y el rate limit.
   */
  TRUST_PROXY: Joi.number()
    .integer()
    .min(0)
    .max(10)
    .default(0)
    .when('NODE_ENV', { is: 'production', then: Joi.required() }),
  /** Límite global por IP: peticiones por ventana. */
  THROTTLE_LIMIT: Joi.number().integer().min(1).default(120),
  THROTTLE_TTL_MS: Joi.number().integer().min(1000).default(60_000),
  /** Multiplica los límites por IP. Solo las pruebas e2e lo suben; fuera de `test` debe ser 1. */
  THROTTLE_SCALE: Joi.number()
    .min(1)
    .default(1)
    .when('NODE_ENV', { not: 'test', then: Joi.valid(1) }),

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
  /** Segundos en que reusar un refresh token recién rotado (dos pestañas a la vez) no se toma por robo. */
  REFRESH_REUSE_GRACE_SECONDS: Joi.number().integer().min(0).default(20),
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
  /** Destino de los avisos internos (contacto, reclamos, alertas de cobros). Obligatorio en producción. */
  STAFF_NOTIFY_EMAIL: Joi.string().when('NODE_ENV', {
    is: 'production',
    then: Joi.string().email().required(),
    otherwise: Joi.string().email().allow('').default(''),
  }),
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

  // Pagos (Ola 2). `fake` solo existe para desarrollo y pruebas: nunca mueve dinero.
  PAYMENT_GATEWAY_MODE: Joi.string()
    .valid('live', 'fake')
    .default('live')
    .when('NODE_ENV', { is: 'production', then: Joi.valid('live') }),
  /** Stripe cobra solo USD. Sin claves, sus operaciones responden 503. */
  STRIPE_SECRET_KEY: Joi.string().allow('').default(''),
  STRIPE_PUBLISHABLE_KEY: Joi.string().allow('').default(''),
  STRIPE_WEBHOOK_SECRET: Joi.string().allow('').default(''),
  /** Culqi cobra USD o PEN. */
  CULQI_SECRET_KEY: Joi.string().allow('').default(''),
  CULQI_PUBLIC_KEY: Joi.string().allow('').default(''),
  CULQI_API_URL: Joi.string().uri().default('https://api.culqi.com/v2'),
  /** Secreto compartido del webhook de Culqi (ver `CulqiGateway.parseWebhook`). */
  CULQI_WEBHOOK_SECRET: Joi.string().allow('').default(''),
  /** Cada cuántos segundos se ejecutan los reembolsos pendientes (0 = apagado). */
  REFUND_SWEEP_SECONDS: Joi.number().integer().min(0).default(60),

  // Comprobantes (Ola 2). `fake` solo existe para desarrollo y pruebas.
  BILLING_MODE: Joi.string()
    .valid('live', 'fake')
    .default('live')
    .when('NODE_ENV', { is: 'production', then: Joi.valid('live') }),
  /** Base de `desertica-billing` (servicio interno, sin puerto público). */
  BILLING_URL: Joi.string().uri().default('http://desertica-billing:8080'),
  /** Token de servicio (`Authorization: Bearer`) que `desertica-billing` exige. */
  BILLING_SERVICE_TOKEN: Joi.string().allow('').default(''),
  /** Cómo envía billing a SUNAT; si no se define decide el servicio. */
  BILLING_SUBMISSION: Joi.string()
    .valid('IMMEDIATE', 'DAILY_SUMMARY')
    .optional(),
  /** Directorio de los XML, CDR y PDF (nunca en Git). S3 compatible queda para después. */
  DOCUMENT_STORAGE_DIR: Joi.string().default('./storage/documents'),
  /** Tipo de cambio USD→PEN de respaldo cuando no hay uno cargado en `Setting`. */
  EXCHANGE_RATE_FALLBACK: Joi.string()
    .pattern(/^\d+(\.\d{1,4})?$/)
    .default('3.7500'),
  /** Base pública del API: arma los enlaces de descarga del comprobante para el cliente. */
  PUBLIC_API_URL: Joi.string().uri().default('http://localhost:3000/api'),
  /** Cada cuántos segundos corre el procesador de comprobantes (0 = apagado). */
  DOCUMENT_WORKER_SECONDS: Joi.number().integer().min(0).default(15),
});

export interface EnvVars {
  NODE_ENV: 'development' | 'test' | 'production';
  PORT: number;
  LOG_LEVEL: string;
  DATABASE_URL: string;
  DB_POOL_MAX: number;
  DB_CONNECTION_TIMEOUT_MS: number;
  DB_STATEMENT_TIMEOUT_MS: number;
  DB_IDLE_IN_TX_TIMEOUT_MS: number;
  REDIS_URL?: string;
  CORS_ORIGINS: string;
  TRUST_PROXY: number;
  THROTTLE_LIMIT: number;
  THROTTLE_TTL_MS: number;
  THROTTLE_SCALE: number;
  PUBLIC_WEB_URL: string;
  GOOGLE_CLIENT_ID: string;
  ALLOWED_EMAIL_DOMAIN: string;
  JWT_ACCESS_SECRET: string;
  JWT_ACCESS_TTL_SECONDS: number;
  REFRESH_TTL_DAYS: number;
  REFRESH_REUSE_GRACE_SECONDS: number;
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
  PAYMENT_GATEWAY_MODE: 'live' | 'fake';
  STRIPE_SECRET_KEY: string;
  STRIPE_PUBLISHABLE_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  CULQI_SECRET_KEY: string;
  CULQI_PUBLIC_KEY: string;
  CULQI_API_URL: string;
  CULQI_WEBHOOK_SECRET: string;
  REFUND_SWEEP_SECONDS: number;
  BILLING_MODE: 'live' | 'fake';
  BILLING_URL: string;
  BILLING_SERVICE_TOKEN: string;
  BILLING_SUBMISSION?: 'IMMEDIATE' | 'DAILY_SUMMARY';
  DOCUMENT_STORAGE_DIR: string;
  EXCHANGE_RATE_FALLBACK: string;
  PUBLIC_API_URL: string;
  DOCUMENT_WORKER_SECONDS: number;
}
