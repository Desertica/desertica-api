import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp, DOMAIN, loginAs, uniqueEmail } from './helpers';

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
        .send({ refreshToken: operator.refreshToken })
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
        .send({ refreshToken: session.refreshToken })
        .expect(200);
      const next = res.body as {
        accessToken: string;
        refreshToken: string;
        expiresIn: number;
      };
      expect(next.refreshToken).not.toBe(session.refreshToken);
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
        .send({ refreshToken: session.refreshToken })
        .expect(200);
      const second = (first.body as { refreshToken: string }).refreshToken;

      await http()
        .post('/api/auth/refresh')
        .send({ refreshToken: session.refreshToken })
        .expect(401);
      // El token legítimo más reciente también quedó revocado.
      await http()
        .post('/api/auth/refresh')
        .send({ refreshToken: second })
        .expect(401);
    });

    it('lets only one of two simultaneous refreshes win', async () => {
      const session = await loginAs(app, 'operator');
      const results = await Promise.all(
        [1, 2, 3].map(() =>
          http()
            .post('/api/auth/refresh')
            .send({ refreshToken: session.refreshToken }),
        ),
      );
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    });

    it('revokes on logout and rejects unknown or expired tokens', async () => {
      const session = await loginAs(app, 'operator');
      await http()
        .post('/api/auth/logout')
        .set(session.auth)
        .send({ refreshToken: session.refreshToken })
        .expect(204);
      await http()
        .post('/api/auth/refresh')
        .send({ refreshToken: session.refreshToken })
        .expect(401);
      await http()
        .post('/api/auth/refresh')
        .send({ refreshToken: 'unknown' })
        .expect(401);

      const other = await loginAs(app, 'operator');
      await prisma.refreshToken.updateMany({
        where: { userId: other.user.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      await http()
        .post('/api/auth/refresh')
        .send({ refreshToken: other.refreshToken })
        .expect(401);
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

  it('uses the configured domain', () => {
    expect(DOMAIN).toBeTruthy();
  });
});
