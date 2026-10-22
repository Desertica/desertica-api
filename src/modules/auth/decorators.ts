import {
  createParamDecorator,
  ExecutionContext,
  SetMetadata,
} from '@nestjs/common';
import { Request } from 'express';
import { AuthUser } from './auth.types';
import { Permission } from './permissions';

export const IS_PUBLIC_KEY = 'isPublic';
export const PERMISSIONS_KEY = 'requiredPermissions';

/** La ruta no exige sesión del staff (endpoints públicos, webhooks, health). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** Exige todas las cadenas indicadas (las de `x-permission` del contrato). */
export const RequirePermission = (...permissions: Permission[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    const request = ctx.switchToHttp().getRequest<Request>();
    if (!request.user) throw new Error('CurrentUser used on a public route');
    return request.user;
  },
);
