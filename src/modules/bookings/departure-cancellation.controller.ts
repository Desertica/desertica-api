import { Body, Controller, HttpCode, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { UuidPipe } from '../../common/pipes/id-pipes';
import { CancelDepartureDto } from '../admin/dto/admin.dto';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, RequirePermission } from '../auth/decorators';
import { DepartureCancellationService } from './departure-cancellation.service';

@Controller('departures')
export class DepartureCancellationController {
  constructor(private readonly cancellation: DepartureCancellationService) {}

  @Post(':id/cancel')
  @HttpCode(202)
  @RequirePermission('departures:cancel')
  cancel(
    @Param('id', UuidPipe) id: string,
    @Body() dto: CancelDepartureDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    return this.cancellation.cancel(id, dto, user, req.ip);
  }
}
