import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { EnvVars } from '../../config/env.validation';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser } from './auth.types';
import { IS_PUBLIC_KEY, PERMISSIONS_KEY } from './decorators';

/**
 * Guard global. Todo es del staff salvo lo marcado `@Public()`. Valida el JWT
 * de acceso, recarga usuario y rol desde la base (una baja o un cambio de rol
 * rige de inmediato) y aplica `@RequirePermission()`.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<EnvVars, true>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const token = this.extractToken(request);
    if (!token) throw new UnauthorizedException('Missing bearer token');

    let userId: string;
    try {
      const payload = await this.jwt.verifyAsync<{ sub: string }>(token, {
        secret: this.config.get('JWT_ACCESS_SECRET', { infer: true }),
      });
      userId = payload.sub;
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { role: true },
    });
    if (!user || !user.active) {
      throw new UnauthorizedException('Invalid or expired token');
    }

    const authUser: AuthUser = {
      id: user.id,
      email: user.email,
      name: user.name,
      roleKey: user.role.key,
      permissions: new Set(user.role.permissions),
    };
    request.user = authUser;

    const required =
      this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, targets) ??
      [];
    const missing = required.filter((p) => !authUser.permissions.has(p));
    if (missing.length > 0) {
      throw new ForbiddenException({
        message: 'Missing permission',
        details: { required: missing },
      });
    }
    return true;
  }

  private extractToken(request: Request): string | null {
    const header = request.headers.authorization;
    if (!header) return null;
    const [scheme, value] = header.split(' ');
    return scheme?.toLowerCase() === 'bearer' && value ? value : null;
  }
}
