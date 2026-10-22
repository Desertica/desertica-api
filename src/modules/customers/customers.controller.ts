import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { UuidPipe } from '../../common/pipes/id-pipes';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, RequirePermission } from '../auth/decorators';
import { CustomerQuery, UpdateCustomerDto } from '../bookings/dto/booking.dto';
import { CustomersService } from './customers.service';

@Controller('customers')
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Get()
  @RequirePermission('customers:read')
  list(@Query() q: CustomerQuery) {
    return this.customers.list(q);
  }

  @Get(':id')
  @RequirePermission('customers:read')
  get(@Param('id', UuidPipe) id: string) {
    return this.customers.get(id);
  }

  @Patch(':id')
  @RequirePermission('customers:write')
  update(
    @Param('id', UuidPipe) id: string,
    @Body() dto: UpdateCustomerDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    return this.customers.update(id, dto, user.id, req.ip);
  }

  @Post(':id/erase')
  @HttpCode(204)
  @RequirePermission('customers:erase')
  async erase(
    @Param('id', UuidPipe) id: string,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ): Promise<void> {
    await this.customers.erase(id, user.id, req.ip);
  }
}
