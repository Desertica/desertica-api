import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  createTestApp,
  DOMAIN,
  loginAs,
  refreshCookie,
  refreshTokenFrom,
  uniqueEmail,
} from './helpers';

describe('Auth y permisos (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });
  afterAll(async () => {
    await app.close();
  });

  describe('POST /auth/google', () => {
    it('logs in a registered user of the allowed domain', async () => {
      const admin = await loginAs(app, 'admin');
      const res = await http().get('/api/auth/me').set(admin.auth).expect(200);
      const me = res.body as {
        email: string;
        role: { key: string; permissions: string[] };
      };
      expect(me.email).toBe(admin.user.email);
      expect(me.role.key).toBe('admin');
      expect(me.role.permissions).toContain('users:write');
    });

    it('rejects an email from another domain', async () => {
      await http()
        .post('/api/auth/google')
        .send({ idToken: 'fake:someone@gmail.com' })
        .expect(403);
    });

    it('rejects a user that was never registered', async () => {
      await http()
        .post('/api/auth/google')
        .send({ idToken: `fake:${uniqueEmail('ghost')}` })
        .expect(403);
    });

    it('rejects an inactive user', async () => {
      const email = uniqueEmail('inactive');
      const role = await prisma.role.findUniqueOrThrow({
        where: { key: 'operator' },
      });
      await prisma.user.create({
        data: { email, name: 'Inactive', roleId: role.id, active: false },
      });
      await http()
        .post('/api/auth/google')
        .send({ idToken: `fake:${email}` })
        .expect(403);
    });

    it('rejects a garbage token with 401 and validates the body with 422', async () => {
      await http()
        .post('/api/auth/google')
        .send({ idToken: 'nope' })
        .expect(401);
      await http().post('/api/auth/google').send({}).expect(422);
    });

    it('refuses to log in when the Google account differs from the one linked', async () => {
      const email = uniqueEmail('linked');
      const role = await prisma.role.findUniqueOrThrow({
        where: { key: 'operator' },
      });
      await prisma.user.create({
        data: {
          email,
          name: 'Linked',
          roleId: role.id,
          googleSub: `other-sub-${email}`,
        },
      });
      await http()
        .post('/api/auth/google')
        .send({ idToken: `fake:${email}` })
        .expect(403);
    });
  });

  describe('guard', () => {
    it('answers 401 without a token or with a bad one', async () => {
      await http().get('/api/auth/me').expect(401);
      await http()
        .get('/api/users')
        .set('Authorization', 'Bearer abc')
        .expect(401);
    });

    it('answers 403 with the missing permission when the role lacks it', async () => {
      const operator = await loginAs(app, 'operator');
      const res = await http().get('/api/users').set(operator.auth).expect(403);
      expect(res.body).toMatchObject({
        statusCode: 403,
        details: { required: ['users:read'] },
      });
      await http().get('/api/audit-logs').set(operator.auth).expect(403);
    });

    it('lets admin through', async () => {
      const admin = await loginAs(app, 'admin');
      await http().get('/api/users').set(admin.auth).expect(200);
      await http().get('/api/roles').set(admin.auth).expect(200);
    });

    it('applies a deactivation immediately to already issued tokens', async () => {
      const admin = await loginAs(app, 'admin');
      const operator = await loginAs(app, 'operator');
      await http().get('/api/auth/me').set(operator.auth).expect(200);
      await http()
        .patch(`/api/users/${operator.user.id}`)
        .set(admin.auth)
        .send({ active: false })
        .expect(200);
      await http().get('/api/auth/me').set(operator.auth).expect(401);
      await http()
        .post('/api/auth/refresh')
        .set(refreshCookie(operator.refreshToken))
        .expect(401);
    });
  });

  describe('refresh tokens', () => {
    it('rotates on every refresh and stores only a hash', async () => {
      const session = await loginAs(app, 'operator');
      const stored = await prisma.refreshToken.findMany({
        where: { userId: session.user.id },
      });
      expect(stored).toHaveLength(1);
      expect(stored[0].tokenHash).not.toBe(session.refreshToken);

      const res = await http()
        .post('/api/auth/refresh')
        .set(refreshCookie(session.refreshToken))
        .expect(200);
      const next = res.body as { accessToken: string; expiresIn: number };
      expect(res.body).not.toHaveProperty('refreshToken');
      expect(refreshTokenFrom(res)).not.toBe(session.refreshToken);
      expect(next.expiresIn).toBeGreaterThan(0);
      await http()
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${next.accessToken}`)
        .expect(200);
    });

    it('revokes every session when an already rotated token is replayed', async () => {
      const session = await loginAs(app, 'operator');
      const first = await http()
        .post('/api/auth/refresh')
        .set(refreshCookie(session.refreshToken))
        .expect(200);
      const second = refreshTokenFrom(first);
      // Pasada la ventana de gracia, reusar el token rotado es un robo.
      await prisma.refreshToken.updateMany({
        where: { userId: session.user.id, revokedAt: { not: null } },
        data: { revokedAt: new Date(Date.now() - 60_000) },
      });

      await http()
        .post('/api/auth/refresh')
        .set(refreshCookie(session.refreshToken))
        .expect(401);
      // El token legítimo más reciente también quedó revocado.
      await http()
        .post('/api/auth/refresh')
        .set(refreshCookie(second))
        .expect(401);
    });

    it('lets only one of two simultaneous refreshes win without logging the user out', async () => {
      const session = await loginAs(app, 'operator');
      const results = await Promise.all(
        [1, 2, 3].map(() =>
          http()
            .post('/api/auth/refresh')
            .set(refreshCookie(session.refreshToken)),
        ),
      );
      const won = results.filter((r) => r.status === 200);
      expect(won).toHaveLength(1);
      // Los perdedores no borran la cookie ni revocan la familia: el token ganador sigue valiendo.
      for (const lost of results.filter((r) => r.status === 401)) {
        expect(lost.headers['set-cookie']).toBeUndefined();
      }
      await http()
        .post('/api/auth/refresh')
        .set(refreshCookie(refreshTokenFrom(won[0])))
        .expect(200);
    });

    it('revokes on logout and rejects unknown or expired tokens', async () => {
      const session = await loginAs(app, 'operator');
      await http()
        .post('/api/auth/logout')
        .set(refreshCookie(session.refreshToken))
        .expect(204)
        .expect('set-cookie', /desertica_refresh=;.*Max-Age=0/i);
      await http()
        .post('/api/auth/refresh')
        .set(refreshCookie(session.refreshToken))
        .expect(401);
      await http()
        .post('/api/auth/refresh')
        .set(refreshCookie('unknown'))
        .expect(401);

      const other = await loginAs(app, 'operator');
      await prisma.refreshToken.updateMany({
        where: { userId: other.user.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      await http()
        .post('/api/auth/refresh')
        .set(refreshCookie(other.refreshToken))
        .expect(401);
    });
  });

  describe('refresh cookie', () => {
    it('is HttpOnly, Strict, scoped to /api/auth and Secure by default', async () => {
      const email = uniqueEmail('cookie');
      const role = await prisma.role.findUniqueOrThrow({
        where: { key: 'operator' },
      });
      await prisma.user.create({
        data: { email, name: 'Cookie', roleId: role.id },
      });
      const res = await http()
        .post('/api/auth/google')
        .send({ idToken: `fake:${email}` })
        .expect(200);
      const cookie = ([] as string[])
        .concat(res.headers['set-cookie'] as unknown as string[])
        .find((c) => c.startsWith('desertica_refresh='))!;
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/Secure/i);
      expect(cookie).toMatch(/SameSite=Strict/i);
      expect(cookie).toMatch(/Path=\/api\/auth(;|$)/);
      expect(res.body).not.toHaveProperty('refreshToken');
    });

    it('answers 401 without the cookie and does not accept a body token', async () => {
      const session = await loginAs(app, 'operator');
      await http().post('/api/auth/refresh').expect(401);
      await http()
        .post('/api/auth/refresh')
        .send({ refreshToken: session.refreshToken })
        .expect(401);
    });

    it('answers 204 on logout even without a cookie', async () => {
      await http().post('/api/auth/logout').expect(204);
    });

    it('refuses to rotate or close the session when the browser declares another origin', async () => {
      const session = await loginAs(app, 'operator');
      const evil = 'https://evil.desertica.pe';
      await http()
        .post('/api/auth/refresh')
        .set('Origin', evil)
        .set(refreshCookie(session.refreshToken))
        .expect(403);
      await http()
        .post('/api/auth/logout')
        .set('Origin', evil)
        .set(refreshCookie(session.refreshToken))
        .expect(403);
      // La cookie sigue vigente: no se rotó ni se revocó.
      await http()
        .post('/api/auth/refresh')
        .set('Origin', 'http://localhost:4300')
        .set(refreshCookie(session.refreshToken))
        .expect(200);
    });

    it('allows credentialed CORS only from configured origins', async () => {
      const allowed = await http()
        .options('/api/auth/refresh')
        .set('Origin', 'http://localhost:4300')
        .set('Access-Control-Request-Method', 'POST');
      expect(allowed.headers['access-control-allow-credentials']).toBe('true');
      expect(allowed.headers['access-control-allow-origin']).toBe(
        'http://localhost:4300',
      );
      const denied = await http()
        .options('/api/auth/refresh')
        .set('Origin', 'https://evil.example')
        .set('Access-Control-Request-Method', 'POST');
      expect(denied.headers['access-control-allow-origin']).toBeUndefined();
    });
  });

  describe('users, roles and audit', () => {
    it('creates and updates users, and audits both', async () => {
      const admin = await loginAs(app, 'admin');
      const operatorRole = await prisma.role.findUniqueOrThrow({
        where: { key: 'operator' },
      });
      const email = uniqueEmail('new').toUpperCase();

      const created = await http()
        .post('/api/users')
        .set(admin.auth)
        .send({ email, name: 'Nuevo', roleId: operatorRole.id })
        .expect(201);
      const user = created.body as {
        id: string;
        email: string;
        role: { key: string };
      };
      expect(user.email).toBe(email.toLowerCase());
      expect(user.role.key).toBe('operator');

      await http()
        .post('/api/users')
        .set(admin.auth)
        .send({ email, name: 'Dup', roleId: operatorRole.id })
        .expect(409);
      await http()
        .post('/api/users')
        .set(admin.auth)
        .send({ email: 'x@gmail.com', name: 'Otro', roleId: operatorRole.id })
        .expect(422);

      await http()
        .patch(`/api/users/${user.id}`)
        .set(admin.auth)
        .send({ name: 'Renombrado' })
        .expect(200);

      const logs = await http()
        .get('/api/audit-logs')
        .query({ entity: 'User', entityId: user.id })
        .set(admin.auth)
        .expect(200);
      const body = logs.body as {
        data: { action: string; actor: string }[];
        meta: { total: number };
      };
      expect(body.data.map((l) => l.action).sort()).toEqual([
        'user.create',
        'user.update',
      ]);
      expect(body.data[0].actor).toBe(admin.user.email);
      expect(body.meta.total).toBe(2);
    });

    it('does not let an admin deactivate themselves', async () => {
      const admin = await loginAs(app, 'admin');
      await http()
        .patch(`/api/users/${admin.user.id}`)
        .set(admin.auth)
        .send({ active: false })
        .expect(400);
    });

    it('records login in the audit log', async () => {
      const admin = await loginAs(app, 'admin');
      const logs = await prisma.auditLog.findMany({
        where: { entityId: admin.user.id, action: 'auth.login' },
      });
      expect(logs).toHaveLength(1);
    });
  });

  describe('session limits, recent login and audit of failures', () => {
    const lastAudit = (action: string, entityId: string) =>
      prisma.auditLog.findFirst({
        where: { action, entityId },
        orderBy: { createdAt: 'desc' },
      });

    it('rejects a personal Google account that uses a company address (no hd) and audits it', async () => {
      const email = uniqueEmail('personal');
      const role = await prisma.role.findUniqueOrThrow({
        where: { key: 'operator' },
      });
      const user = await prisma.user.create({
        data: { email, name: 'Personal', roleId: role.id },
      });
      await http()
        .post('/api/auth/google')
        .send({ idToken: `fake:${email}:Personal:` })
        .expect(403);
      await http()
        .post('/api/auth/google')
        .send({ idToken: `fake:${email}:Personal:otra-empresa.com` })
        .expect(403);
      const log = await lastAudit('auth.login_failed', user.id);
      expect(log?.after).toMatchObject({
        reason: 'not_workspace_account',
        email,
      });
      // El usuario no quedó ligado a esa cuenta.
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { id: user.id } }))
          .googleSub,
      ).toBeNull();
    });

    it('audits failed logins without storing outside email addresses', async () => {
      const ghost = uniqueEmail('ghost');
      await http()
        .post('/api/auth/google')
        .send({ idToken: `fake:${ghost}` })
        .expect(403);
      const failed = await prisma.auditLog.findFirst({
        where: {
          action: 'auth.login_failed',
          after: { path: ['email'], equals: ghost },
        },
      });
      expect(failed?.after).toMatchObject({ reason: 'not_invited' });

      const before = await prisma.auditLog.count({
        where: { action: 'auth.login_failed' },
      });
      await http()
        .post('/api/auth/google')
        .send({ idToken: 'fake:someone@gmail.com' })
        .expect(403);
      await http()
        .post('/api/auth/google')
        .send({ idToken: 'garbage' })
        .expect(401);
      const rows = await prisma.auditLog.findMany({
        where: { action: 'auth.login_failed' },
        orderBy: { createdAt: 'desc' },
        take: 2,
      });
      expect(
        await prisma.auditLog.count({ where: { action: 'auth.login_failed' } }),
      ).toBe(before + 2);
      expect(rows.map((r) => r.after)).toEqual([
        { reason: 'invalid_google_token' },
        { reason: 'wrong_domain' },
      ]);
    });

    it('audits logout once', async () => {
      const session = await loginAs(app, 'operator');
      await http()
        .post('/api/auth/logout')
        .set(refreshCookie(session.refreshToken))
        .expect(204);
      await http()
        .post('/api/auth/logout')
        .set(refreshCookie(session.refreshToken))
        .expect(204);
      expect(
        await prisma.auditLog.count({
          where: { action: 'auth.logout', entityId: session.user.id },
        }),
      ).toBe(1);
    });

    it('ends the session 12 hours after the Google login no matter how often it is refreshed', async () => {
      const session = await loginAs(app, 'operator');
      const login = await prisma.refreshToken.findFirstOrThrow({
        where: { userId: session.user.id },
      });
      const twelveHours = 12 * 3_600_000;
      expect(
        login.expiresAt.getTime() - login.authenticatedAt.getTime(),
      ).toBeLessThanOrEqual(twelveHours);

      const res = await http()
        .post('/api/auth/refresh')
        .set(refreshCookie(session.refreshToken))
        .expect(200);
      expect((res.body as { sessionExpiresAt: string }).sessionExpiresAt).toBe(
        login.expiresAt.toISOString(),
      );
      const rotated = await prisma.refreshToken.findFirstOrThrow({
        where: { userId: session.user.id, revokedAt: null },
      });
      // Rotar no alarga la sesión ni cambia el login de origen.
      expect(rotated.expiresAt).toEqual(login.expiresAt);
      expect(rotated.authenticatedAt).toEqual(login.authenticatedAt);

      // Pasadas las 12 h el refresh ya no sirve aunque el token no se haya usado.
      await prisma.refreshToken.update({
        where: { id: rotated.id },
        data: {
          authenticatedAt: new Date(Date.now() - twelveHours - 60_000),
          expiresAt: new Date(Date.now() - 60_000),
        },
      });
      await http()
        .post('/api/auth/refresh')
        .set(refreshCookie(refreshTokenFrom(res)))
        .expect(401);
    });

    it('asks for a recent Google login before sensitive actions; a refresh does not count', async () => {
      const admin = await loginAs(app, 'admin');
      const role = await prisma.role.findUniqueOrThrow({
        where: { key: 'readonly' },
      });
      // Login de hace 20 minutos: se renueva el token y sigue valiendo para lo normal.
      await prisma.refreshToken.updateMany({
        where: { userId: admin.user.id },
        data: { authenticatedAt: new Date(Date.now() - 20 * 60_000) },
      });
      const res = await http()
        .post('/api/auth/refresh')
        .set(refreshCookie(admin.refreshToken))
        .expect(200);
      const stale = {
        Authorization: `Bearer ${(res.body as { accessToken: string }).accessToken}`,
      };
      await http().get('/api/users').set(stale).expect(200);
      const denied = await http()
        .post('/api/users')
        .set(stale)
        .send({ email: uniqueEmail('late'), name: 'Tarde', roleId: role.id })
        .expect(403);
      expect(denied.body).toMatchObject({
        message: 'Recent login required',
        details: { reason: 'reauth_required', maxAgeMinutes: 10 },
      });
      for (const [method, url] of [
        ['put', '/api/settings'],
        ['put', '/api/companies/current'],
        ['post', '/api/legal-documents'],
        ['post', `/api/customers/${admin.user.id}/erase`],
        ['post', `/api/payments/${admin.user.id}/refunds`],
      ] as const) {
        const r = await http()[method](url).set(stale).send({});
        expect([
          r.status,
          (r.body as { details?: { reason?: string } }).details?.reason,
        ]).toEqual([403, 'reauth_required']);
      }

      // Volver a entrar con Google lo destraba.
      const fresh = await http()
        .post('/api/auth/google')
        .send({ idToken: `fake:${admin.user.email}` })
        .expect(200);
      await http()
        .post('/api/users')
        .set(
          'Authorization',
          `Bearer ${(fresh.body as { accessToken: string }).accessToken}`,
        )
        .send({ email: uniqueEmail('fresh'), name: 'Nuevo', roleId: role.id })
        .expect(201);
    });

    it('lists the four fixed roles', async () => {
      const admin = await loginAs(app, 'admin');
      const res = await http().get('/api/roles').set(admin.auth).expect(200);
      const roles = (res.body as { data: { key: string; name: string }[] })
        .data;
      // Otras pruebas crean roles propios en la misma base: se buscan los 4 fijos.
      expect(roles.map((r) => [r.key, r.name])).toEqual(
        expect.arrayContaining([
          ['admin', 'Administrador'],
          ['operator', 'Operaciones'],
          ['finance', 'Finanzas'],
          ['readonly', 'Solo lectura'],
        ]),
      );
    });

    it('lets a read-only user open the dashboard data it can see, and blocks reports otherwise', async () => {
      const readonly = await loginAs(app, 'readonly');
      const operator = await loginAs(app, 'operator');
      await http().get('/api/customers').set(readonly.auth).expect(403);
      await http()
        .get('/api/reports/sales')
        .query({ from: '2026-01-01', to: '2026-01-02', groupBy: 'day' })
        .set(operator.auth)
        .expect(403);
    });
  });

  it('uses the configured domain', () => {
    expect(DOMAIN).toBeTruthy();
  });
});
