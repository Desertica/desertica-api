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
import {
  GOOGLE_VERIFIER,
  type GoogleIdentity,
  type GoogleIdTokenVerifier,
} from './google-verifier';

/** Cuerpo de la sesión (el refresh token viaja aparte, en la cookie). */
export interface Session {
  accessToken: string;
  expiresIn: number;
  /** Fin absoluto de la sesión (ISO 8601): después hay que volver a entrar con Google. */
  sessionExpiresAt: string;
  user: UserDto;
}

export interface IssuedSession {
  session: Session;
  refreshToken: string;
  /** Segundos de vigencia del refresh token (para `Max-Age` de la cookie). */
  refreshMaxAgeSeconds: number;
}

/** Dos refresh simultáneos con el mismo token: el perdedor no es un robo, así que la cookie no se borra. */
export class RefreshRaceException extends UnauthorizedException {
  constructor() {
    super('Invalid refresh token');
  }
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
    const domain = this.config
      .get('ALLOWED_EMAIL_DOMAIN', { infer: true })
      .toLowerCase();
    // Cada rechazo queda en la bitácora; el correo solo si es de la empresa (no se guardan ajenos).
    const fail = async (reason: string, email?: string, userId?: string) => {
      await this.audit.record({
        actorUserId: userId ?? null,
        action: 'auth.login_failed',
        entity: 'User',
        entityId: userId ?? 'unknown',
        after: {
          reason,
          ...(email?.endsWith(`@${domain}`) ? { email } : {}),
        },
        ip,
      });
    };
    let identity: GoogleIdentity;
    try {
      identity = await this.google.verify(idToken);
    } catch (error) {
      await fail('invalid_google_token');
      throw error;
    }
    const email = identity.email.trim().toLowerCase();

    // Mismo mensaje para todo rechazo: no revela si el correo está dado de alta.
    const denied = new ForbiddenException('Access denied');
    const user = await this.prisma.user.findUnique({
      where: { email },
      include: { role: true },
    });
    const reason = !identity.emailVerified
      ? 'email_not_verified'
      : email.split('@')[1] !== domain
        ? 'wrong_domain'
        : // Solo cuentas de Google Workspace de la empresa: una cuenta personal de Google
          // creada con una dirección de la empresa no trae `hd`.
          identity.hostedDomain?.toLowerCase() !== domain
          ? 'not_workspace_account'
          : !user
            ? 'not_invited'
            : !user.active
              ? 'inactive'
              : user.googleSub && user.googleSub !== identity.sub
                ? 'google_account_mismatch'
                : null;
    if (reason || !user) {
      await fail(reason ?? 'not_invited', email, user?.id);
      throw denied;
    }

    const now = new Date();
    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data: { googleSub: identity.sub, lastLoginAt: now },
      include: { role: true },
    });
    await this.audit.record({
      actorUserId: user.id,
      action: 'auth.login',
      entity: 'User',
      entityId: user.id,
      ip,
    });
    return this.issueSession(updated, now);
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
      const graceMs =
        this.config.get('REFRESH_REUSE_GRACE_SECONDS', { infer: true }) * 1000;
      // Rotado hace instantes: otra pestaña lo usó a la vez; no es robo.
      if (Date.now() - stored.revokedAt.getTime() < graceMs) {
        throw new RefreshRaceException();
      }
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
    if (claimed.count !== 1) throw new RefreshRaceException();

    // La sesión nueva hereda el login original: renovar no la alarga.
    return this.issueSession(
      stored.user,
      stored.authenticatedAt,
      stored.expiresAt,
    );
  }

  async logout(refreshToken: string, ip?: string): Promise<void> {
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hashToken(refreshToken) },
      select: { id: true, userId: true, revokedAt: true },
    });
    if (!stored || stored.revokedAt) return;
    const { count } = await this.prisma.refreshToken.updateMany({
      where: { id: stored.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (count === 1) {
      await this.audit.record({
        actorUserId: stored.userId,
        action: 'auth.logout',
        entity: 'User',
        entityId: stored.userId,
        ip,
      });
    }
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
    authenticatedAt: Date,
    sessionEndsAt?: Date,
  ): Promise<IssuedSession> {
    const now = Date.now();
    const ttlDays = this.config.get('REFRESH_TTL_DAYS', { infer: true });
    const maxHours = this.config.get('SESSION_MAX_HOURS', { infer: true });
    const endsAt = Math.min(
      sessionEndsAt?.getTime() ?? Infinity,
      now + ttlDays * 86_400_000,
      authenticatedAt.getTime() + maxHours * 3_600_000,
    );
    const remainingSeconds = Math.floor((endsAt - now) / 1000);
    if (remainingSeconds <= 0) {
      throw new UnauthorizedException('Invalid refresh token');
    }
    // El token de acceso tampoco vive más allá del fin de la sesión.
    const expiresIn = Math.min(
      this.config.get('JWT_ACCESS_TTL_SECONDS', { infer: true }),
      remainingSeconds,
    );
    const accessToken = await this.jwt.signAsync(
      {
        sub: user.id,
        email: user.email,
        auth_time: Math.floor(authenticatedAt.getTime() / 1000),
      },
      {
        secret: this.config.get('JWT_ACCESS_SECRET', { infer: true }),
        expiresIn,
      },
    );
    const refreshToken = randomBytes(32).toString('base64url');
    await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(refreshToken),
        expiresAt: new Date(endsAt),
        authenticatedAt,
      },
    });
    return {
      session: {
        accessToken,
        expiresIn,
        sessionExpiresAt: new Date(endsAt).toISOString(),
        user: toUserDto(user),
      },
      refreshToken,
      refreshMaxAgeSeconds: remainingSeconds,
    };
  }
}
