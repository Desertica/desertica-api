import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
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
}
