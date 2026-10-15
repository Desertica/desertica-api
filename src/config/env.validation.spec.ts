import { envSchema } from './env.validation';

describe('envSchema', () => {
  const base = { DATABASE_URL: 'postgresql://u:p@localhost:5432/db' };

  it('applies defaults in development', () => {
    const result = envSchema.validate(base);
    expect(result.error).toBeUndefined();
    expect(result.value as unknown).toMatchObject({
      NODE_ENV: 'development',
      PORT: 3000,
    });
  });

  it('requires DATABASE_URL', () => {
    expect(envSchema.validate({}).error?.message).toMatch(/DATABASE_URL/);
  });

  it('requires CORS_ORIGINS and the JWT secret in production', () => {
    const { error } = envSchema.validate(
      { ...base, NODE_ENV: 'production' },
      { abortEarly: false },
    );
    expect(error?.message).toMatch(/CORS_ORIGINS/);
    expect(error?.message).toMatch(/JWT_ACCESS_SECRET/);
    expect(error?.message).toMatch(/TURNSTILE_SECRET_KEY/);
    expect(error?.message).toMatch(/PUBLIC_WEB_URL/);
  });

  it('accepts a complete production config', () => {
    const { error } = envSchema.validate({
      ...base,
      NODE_ENV: 'production',
      CORS_ORIGINS: 'https://desertica.pe',
      JWT_ACCESS_SECRET: 'x'.repeat(40),
      TURNSTILE_SECRET_KEY: 'ts',
      GOOGLE_CLIENT_ID: 'gid',
      PUBLIC_WEB_URL: 'https://desertica.pe',
      MAIL_DRIVER: 'smtp',
      SMTP_HOST: 'smtp-relay.gmail.com',
      MAIL_FROM: 'Desértica <reservas@desertica.pe>',
    });
    expect(error).toBeUndefined();
  });

  describe('mail', () => {
    const smtp = {
      ...base,
      MAIL_DRIVER: 'smtp',
      SMTP_HOST: 'smtp-relay.gmail.com',
      MAIL_FROM: 'Desértica <reservas@desertica.pe>',
    };

    it('defaults to the log driver outside production', () => {
      expect(
        (envSchema.validate(base).value as { MAIL_DRIVER: string }).MAIL_DRIVER,
      ).toBe('log');
    });

    it('requires the host and sender with the smtp driver', () => {
      const { error } = envSchema.validate(
        { ...base, MAIL_DRIVER: 'smtp' },
        { abortEarly: false },
      );
      expect(error?.message).toMatch(/SMTP_HOST/);
      expect(error?.message).toMatch(/MAIL_FROM/);
      expect(envSchema.validate(smtp).error).toBeUndefined();
    });

    it('requires the smtp driver and TLS in production', () => {
      const prod = {
        ...smtp,
        NODE_ENV: 'production',
        CORS_ORIGINS: 'https://desertica.pe',
        JWT_ACCESS_SECRET: 'x'.repeat(40),
        TURNSTILE_SECRET_KEY: 'ts',
        GOOGLE_CLIENT_ID: 'gid',
        PUBLIC_WEB_URL: 'https://desertica.pe',
      };
      expect(envSchema.validate(prod).error).toBeUndefined();
      expect(
        envSchema.validate({ ...prod, MAIL_DRIVER: 'log' }).error?.message,
      ).toMatch(/MAIL_DRIVER/);
      expect(
        envSchema.validate({ ...prod, SMTP_REQUIRE_TLS: false }).error?.message,
      ).toMatch(/SMTP_REQUIRE_TLS/);
      const { MAIL_DRIVER: _omit, ...withoutDriver } = prod;
      void _omit;
      expect(envSchema.validate(withoutDriver).error?.message).toMatch(
        /MAIL_DRIVER/,
      );
    });

    it('wants the SMTP user and password together', () => {
      expect(
        envSchema.validate({ ...smtp, SMTP_USER: 'bot@desertica.pe' }).error
          ?.message,
      ).toMatch(/SMTP_PASSWORD/);
      expect(
        envSchema.validate({
          ...smtp,
          SMTP_USER: 'bot@desertica.pe',
          SMTP_PASSWORD: 'secret',
        }).error,
      ).toBeUndefined();
    });
  });

  it('forbids the fake Google login in production', () => {
    const { error } = envSchema.validate(
      {
        ...base,
        NODE_ENV: 'production',
        CORS_ORIGINS: 'https://desertica.pe',
        JWT_ACCESS_SECRET: 'x'.repeat(40),
        AUTH_ALLOW_FAKE_GOOGLE: true,
      },
      { abortEarly: false },
    );
    expect(error?.message).toMatch(/AUTH_ALLOW_FAKE_GOOGLE/);
  });

  it('rejects a non-postgres database URL', () => {
    expect(
      envSchema.validate({ DATABASE_URL: 'mysql://x' }).error,
    ).toBeDefined();
  });
});
