import { INestApplication } from '@nestjs/common';
import { Test, TestingModuleBuilder } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/common/configure-app';
import { PrismaService } from '../src/prisma/prisma.service';
import { ensureSystemRoles } from '../src/modules/roles/system-roles';

export const DOMAIN = process.env.ALLOWED_EMAIL_DOMAIN ?? 'desertica.pe';

export async function createTestApp(
  customize: (builder: TestingModuleBuilder) => TestingModuleBuilder = (b) => b,
): Promise<INestApplication<App>> {
  const moduleFixture = await customize(
    Test.createTestingModule({ imports: [AppModule] }),
  ).compile();
  const app = moduleFixture.createNestApplication<INestApplication<App>>();
  configureApp(app);
  await app.init();
  await ensureSystemRoles(app.get(PrismaService));
  return app;
}

export function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@${DOMAIN}`;
}

export interface TestSession {
  accessToken: string;
  refreshToken: string;
  auth: { Authorization: string };
  user: { id: string; email: string };
}

/** Da de alta (directo en la base) y autentica a un usuario del staff. */
export async function loginAs(
  app: INestApplication<App>,
  roleKey: 'admin' | 'operator',
): Promise<TestSession> {
  const prisma = app.get(PrismaService);
  const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
  const email = uniqueEmail(roleKey);
  await prisma.user.create({
    data: { email, name: `Test ${roleKey}`, roleId: role.id },
  });
  const res = await request(app.getHttpServer())
    .post('/api/auth/google')
    .send({ idToken: `fake:${email}` })
    .expect(200);
  const body = res.body as {
    accessToken: string;
    refreshToken: string;
    user: { id: string; email: string };
  };
  return {
    accessToken: body.accessToken,
    refreshToken: body.refreshToken,
    auth: { Authorization: `Bearer ${body.accessToken}` },
    user: body.user,
  };
}
