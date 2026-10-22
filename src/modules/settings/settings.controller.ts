import { Body, Controller, Get, Put, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, RequirePermission } from '../auth/decorators';
import { SettingsService } from './settings.service';

@Controller('settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  @RequirePermission('settings:read')
  get() {
    return this.settings.getAll();
  }

  @Put()
  @RequirePermission('settings:write')
  save(
    @Body() body: Record<string, unknown>,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    // La auditoría se escribe en la misma transacción que el cambio.
    return this.settings.save(body, { actorUserId: user.id, ip: req.ip });
  }
}
