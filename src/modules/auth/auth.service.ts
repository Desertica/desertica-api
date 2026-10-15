import {
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes } from 'node:crypto';
import { EnvVars } from '../../config/env.validation';
import { Role, User } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { toUserDto, UserDto } from '../users/user.mapper';
import { GOOGLE_VERIFIER, type GoogleIdTokenVerifier } from './google-verifier';

/** Cuerpo de la sesión (el refresh token viaja aparte, en la cookie). */
export interface Session {
  accessToken: string;
  expiresIn: number;
  user: UserDto;
}

export interface IssuedSession {
  session: Session;
  refreshToken: string;
  /** Segundos de vigencia del refresh token (para `Max-Age` de la cookie). */
  refreshMaxAgeSeconds: number;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
    private readonly config: ConfigService<EnvVars, true>,
    @Inject(GOOGLE_VERIFIER) private readonly google: GoogleIdTokenVerifier,
  ) {}

  async loginWithGoogle(idToken: string, ip?: string): Promise<IssuedSession> {
    const identity = await this.google.verify(idToken);
    const domain = this.config
      .get('ALLOWED_EMAIL_DOMAIN', { infer: true })
      .toLowerCase();
    const email = identity.email.trim().toLowerCase();

    // Mismo mensaje para todo rechazo: no revela si el correo está dado de alta.
    const denied = new ForbiddenException('Access denied');
    if (!identity.emailVerified) throw denied;
    if (email.split('@')[1] !== domain) throw denied;
    if (
      identity.hostedDomain &&
      identity.hostedDomain.toLowerCase() !== domain
    ) {
      throw denied;
    }

    const user = await this.prisma.user.findUnique({
      where: { email },
      include: { role: true },
    });
    if (!user || !user.active) throw denied;
    if (user.googleSub && user.googleSub !== identity.sub) throw denied;

    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data: { googleSub: identity.sub, lastLoginAt: new Date() },
      include: { role: true },
    });
    await this.audit.record({
      actorUserId: user.id,
      action: 'auth.login',
      entity: 'User',
      entityId: user.id,
      ip,
    });
    return this.issueSession(updated);
  }

  /** Rota el refresh token: el usado queda revocado y se emite uno nuevo. */
  async refresh(refreshToken: string, ip?: string): Promise<IssuedSession> {
    const invalid = new UnauthorizedException('Invalid refresh token');
    const hash = hashToken(refreshToken);
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hash },
      include: { user: { include: { role: true } } },
    });
    if (!stored) throw invalid;

    if (stored.revokedAt) {
      // Reuso de un token ya rotado: se asume robo y se cierran todas las sesiones.
      await this.prisma.refreshToken.updateMany({
        where: { userId: stored.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await this.audit.record({
        actorUserId: stored.userId,
        action: 'auth.refresh_reuse',
        entity: 'User',
        entityId: stored.userId,
        ip,
      });
      throw invalid;
    }
    if (stored.expiresAt <= new Date() || !stored.user.active) throw invalid;

    // Revocación condicional: de dos peticiones simultáneas solo una rota.
    const claimed = await this.prisma.refreshToken.updateMany({
      where: { id: stored.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (claimed.count !== 1) throw invalid;

    return this.issueSession(stored.user);
  }

  async logout(refreshToken: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: hashToken(refreshToken), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async me(userId: string): Promise<UserDto> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: { role: true },
    });
    return toUserDto(user);
  }

  private async issueSession(
    user: User & { role: Role },
  ): Promise<IssuedSession> {
    const expiresIn = this.config.get('JWT_ACCESS_TTL_SECONDS', {
      infer: true,
    });
    const accessToken = await this.jwt.signAsync(
      { sub: user.id, email: user.email },
      {
        secret: this.config.get('JWT_ACCESS_SECRET', { infer: true }),
        expiresIn,
      },
    );
    const refreshToken = randomBytes(32).toString('base64url');
    const ttlDays = this.config.get('REFRESH_TTL_DAYS', { infer: true });
    await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(refreshToken),
        expiresAt: new Date(Date.now() + ttlDays * 86_400_000),
      },
    });
    return {
      session: { accessToken, expiresIn, user: toUserDto(user) },
      refreshToken,
      refreshMaxAgeSeconds: ttlDays * 86_400,
    };
  }
}
