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
  });

  it('accepts a complete production config', () => {
    const { error } = envSchema.validate({
      ...base,
      NODE_ENV: 'production',
      CORS_ORIGINS: 'https://desertica.pe',
      JWT_ACCESS_SECRET: 'x'.repeat(40),
    });
    expect(error).toBeUndefined();
  });

  it('forbids the fake Google login in production', () => {
    const { error } = envSchema.validate({
      ...base,
      NODE_ENV: 'production',
      CORS_ORIGINS: 'https://desertica.pe',
      JWT_ACCESS_SECRET: 'x'.repeat(40),
      AUTH_ALLOW_FAKE_GOOGLE: true,
    });
    expect(error?.message).toMatch(/AUTH_ALLOW_FAKE_GOOGLE/);
  });

  it('rejects a non-postgres database URL', () => {
    expect(
      envSchema.validate({ DATABASE_URL: 'mysql://x' }).error,
    ).toBeDefined();
  });
});
