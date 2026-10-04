import {
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  UnauthorizedException,
  Body,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { rateLimit } from '../../common/throttle';
import { EnvVars } from '../../config/env.validation';
import { AuthService, IssuedSession, Session } from './auth.service';
import type { AuthUser } from './auth.types';
import { CurrentUser, Public } from './decorators';
import { GoogleLoginDto } from './dto/auth.dto';
import {
  clearRefreshCookie,
  readCookie,
  REFRESH_COOKIE,
  setRefreshCookie,
} from './refresh-cookie';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService<EnvVars, true>,
  ) {}

  private get secure(): boolean {
    return this.config.get('REFRESH_COOKIE_SECURE', { infer: true });
  }

  private withCookie(res: Response, issued: IssuedSession): Session {
    setRefreshCookie(
      res,
      issued.refreshToken,
      issued.refreshMaxAgeSeconds,
      this.secure,
    );
    return issued.session;
  }

  @Public()
  @Throttle(rateLimit(10, 60_000))
  @Post('google')
  @HttpCode(200)
  async google(
    @Body() dto: GoogleLoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Session> {
    return this.withCookie(
      res,
      await this.auth.loginWithGoogle(dto.idToken, req.ip),
    );
  }

  /** Sin cuerpo: el refresh token llega solo en la cookie `desertica_refresh`. */
  @Public()
  @Throttle(rateLimit(30, 60_000))
  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Session> {
    const token = readCookie(req, REFRESH_COOKIE);
    if (!token) throw new UnauthorizedException('Missing refresh cookie');
    try {
      return this.withCookie(res, await this.auth.refresh(token, req.ip));
    } catch (error) {
      // Un refresh inválido no deja una cookie inútil en el navegador.
      clearRefreshCookie(res, this.secure);
      throw error;
    }
  }

  /** Pública: debe poder cerrarse la sesión aunque el token de acceso ya venciera. */
  @Public()
  @Throttle(rateLimit(30, 60_000))
  @Post('logout')
  @HttpCode(204)
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const token = readCookie(req, REFRESH_COOKIE);
    if (token) await this.auth.logout(token);
    clearRefreshCookie(res, this.secure);
  }

  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.auth.me(user.id);
  }
}
