import { Role, User } from '../../generated/prisma/client';

export interface RoleDto {
  id: string;
  key: string;
  name: string;
  permissions: string[];
}

export interface UserDto {
  id: string;
  email: string;
  name: string;
  active: boolean;
  role: RoleDto;
  lastLoginAt: Date | null;
}

export function toRoleDto(role: Role): RoleDto {
  return {
    id: role.id,
    key: role.key,
    name: role.name,
    permissions: role.permissions,
  };
}

export function toUserDto(user: User & { role: Role }): UserDto {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    active: user.active,
    role: toRoleDto(user.role),
    lastLoginAt: user.lastLoginAt,
  };
}
