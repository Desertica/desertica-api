import { Controller, Get } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RequirePermission } from '../auth/decorators';
import { toRoleDto } from '../users/user.mapper';

@Controller('roles')
export class RolesController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @RequirePermission('users:read')
  async list() {
    const roles = await this.prisma.role.findMany({
      orderBy: { key: 'asc' },
    });
    return { data: roles.map(toRoleDto) };
  }
}
