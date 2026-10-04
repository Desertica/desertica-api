import { Body, Controller, Get, Put, Req } from '@nestjs/common';
import type { Request } from 'express';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, RequirePermission } from '../auth/decorators';
import { SettingsService } from './settings.service';

@Controller('settings')
export class SettingsController {
  constructor(
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermission('settings:read')
  get() {
    return this.settings.getAll();
  }

  @Put()
  @RequirePermission('settings:write')
  async save(
    @Body() body: Record<string, unknown>,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    const before = await this.settings.getAll();
    const after = await this.settings.save(body);
    await this.audit.record({
      actorUserId: user.id,
      action: 'settings.update',
      entity: 'Setting',
      entityId: 'all',
      before,
      after,
      ip: req.ip,
    });
    return after;
  }
}
