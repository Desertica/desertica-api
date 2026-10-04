import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnvVars } from '../../config/env.validation';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../auth/auth.types';
import { CreateUserDto, UpdateUserDto } from './dto/user.dto';
import { toUserDto, UserDto } from './user.mapper';

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: ConfigService<EnvVars, true>,
  ) {}

  async list(): Promise<{ data: UserDto[] }> {
    const users = await this.prisma.user.findMany({
      include: { role: true },
      orderBy: { createdAt: 'asc' },
    });
    return { data: users.map(toUserDto) };
  }

  async create(dto: CreateUserDto, actor: AuthUser, ip?: string) {
    const email = dto.email.trim().toLowerCase();
    const domain = this.config.get('ALLOWED_EMAIL_DOMAIN', { infer: true });
    if (email.split('@')[1] !== domain.toLowerCase()) {
      throw new UnprocessableEntityException(
        `Email must belong to the ${domain} domain`,
      );
    }
    const role = await this.prisma.role.findUnique({
      where: { id: dto.roleId },
    });
    if (!role) throw new UnprocessableEntityException('Unknown roleId');
    if (await this.prisma.user.findUnique({ where: { email } })) {
      throw new ConflictException('User already exists');
    }

    const user = await this.prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: { email, name: dto.name, roleId: role.id },
        include: { role: true },
      });
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: 'user.create',
          entity: 'User',
          entityId: created.id,
          after: { email, roleKey: role.key },
          ip,
        },
        tx,
      );
      return created;
    });
    return toUserDto(user);
  }

  async update(id: string, dto: UpdateUserDto, actor: AuthUser, ip?: string) {
    const before = await this.prisma.user.findUnique({
      where: { id },
      include: { role: true },
    });
    if (!before) throw new NotFoundException('User not found');
    if (id === actor.id && dto.active === false) {
      throw new BadRequestException('You cannot deactivate yourself');
    }
    let roleKey = before.role.key;
    if (dto.roleId) {
      const role = await this.prisma.role.findUnique({
        where: { id: dto.roleId },
      });
      if (!role) throw new UnprocessableEntityException('Unknown roleId');
      roleKey = role.key;
    }
    if (id === actor.id && dto.roleId && roleKey !== before.role.key) {
      throw new BadRequestException('You cannot change your own role');
    }

    const user = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.roleId !== undefined ? { roleId: dto.roleId } : {}),
          ...(dto.active !== undefined ? { active: dto.active } : {}),
        },
        include: { role: true },
      });
      if (dto.active === false) {
        await tx.refreshToken.updateMany({
          where: { userId: id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: 'user.update',
          entity: 'User',
          entityId: id,
          before: {
            name: before.name,
            active: before.active,
            roleKey: before.role.key,
          },
          after: { name: updated.name, active: updated.active, roleKey },
          ip,
        },
        tx,
      );
      return updated;
    });
    return toUserDto(user);
  }
}
