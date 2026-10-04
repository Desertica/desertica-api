import { Body, Controller, Get, Param, Patch, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { UuidPipe } from '../../common/pipes/id-pipes';
import { CurrentUser, RequirePermission } from '../auth/decorators';
import type { AuthUser } from '../auth/auth.types';
import { CreateUserDto, UpdateUserDto } from './dto/user.dto';
import { UsersService } from './users.service';

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @RequirePermission('users:read')
  list() {
    return this.users.list();
  }

  @Post()
  @RequirePermission('users:write')
  create(
    @Body() dto: CreateUserDto,
    @CurrentUser() actor: AuthUser,
    @Req() req: Request,
  ) {
    return this.users.create(dto, actor, req.ip);
  }

  @Patch(':id')
  @RequirePermission('users:write')
  update(
    @Param('id', UuidPipe) id: string,
    @Body() dto: UpdateUserDto,
    @CurrentUser() actor: AuthUser,
    @Req() req: Request,
  ) {
    return this.users.update(id, dto, actor, req.ip);
  }
}
