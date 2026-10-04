import { Controller, Get, Query } from '@nestjs/common';
import { IsOptional, IsString } from 'class-validator';
import { PaginationQuery } from '../../common/pagination/pagination';
import { RequirePermission } from '../auth/decorators';
import { AuditService } from './audit.service';

class AuditQuery extends PaginationQuery {
  @IsOptional()
  @IsString()
  entity?: string;

  @IsOptional()
  @IsString()
  entityId?: string;
}

@Controller('audit-logs')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @RequirePermission('audit:read')
  list(@Query() query: AuditQuery) {
    return this.audit.list(query);
  }
}
