import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { UuidPipe } from '../../common/pipes/id-pipes';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, RequirePermission } from '../auth/decorators';
import { BlockedIdentitiesService } from './blocked-identities.service';
import { CompanyService } from './company.service';
import { ContactMessagesService } from './contact-messages.service';
import {
  CompanyDto,
  ContactMessageQuery,
  CreateBlockedIdentityDto,
  CreateSeriesDto,
  DashboardQuery,
  SalesReportQuery,
  UpdateContactMessageDto,
} from './dto/admin.dto';
import { ReportsService, toCsv } from './reports.service';

@Controller()
export class CompanyController {
  constructor(private readonly company: CompanyService) {}

  @Get('companies/current')
  @RequirePermission('company:read')
  get() {
    return this.company.get();
  }

  @Put('companies/current')
  @RequirePermission('company:write')
  save(
    @Body() dto: CompanyDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    return this.company.save(dto, user.id, req.ip);
  }

  @Get('series')
  @RequirePermission('company:read')
  listSeries() {
    return this.company.listSeries();
  }

  @Post('series')
  @RequirePermission('company:write')
  createSeries(
    @Body() dto: CreateSeriesDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    return this.company.createSeries(dto, user.id, req.ip);
  }
}

@Controller('blocked-identities')
export class BlockedIdentitiesController {
  constructor(private readonly blocked: BlockedIdentitiesService) {}

  @Get()
  @RequirePermission('fraud:read')
  list() {
    return this.blocked.list();
  }

  @Post()
  @RequirePermission('fraud:write')
  create(
    @Body() dto: CreateBlockedIdentityDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    return this.blocked.create(dto, user.id, req.ip);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('fraud:write')
  async remove(
    @Param('id', UuidPipe) id: string,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ): Promise<void> {
    await this.blocked.remove(id, user.id, req.ip);
  }
}

@Controller()
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('dashboard/summary')
  @RequirePermission('reports:read')
  dashboard(@Query() q: DashboardQuery) {
    return this.reports.dashboard(q.from, q.to);
  }

  @Get('reports/sales')
  @RequirePermission('reports:read')
  async sales(
    @Query() q: SalesReportQuery,
    @Res({ passthrough: true }) res: Response,
  ) {
    const data = await this.reports.sales(q.from, q.to, q.groupBy ?? 'day');
    if (q.format !== 'csv') return { data };
    res.type('text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="sales-${q.from}-${q.to}.csv"`,
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return toCsv(data);
  }
}

@Controller('contact-messages')
export class ContactMessagesController {
  constructor(private readonly messages: ContactMessagesService) {}

  @Get()
  @RequirePermission('customers:read')
  list(@Query() q: ContactMessageQuery) {
    return this.messages.list(q);
  }

  @Patch(':id')
  @RequirePermission('customers:write')
  update(
    @Param('id', UuidPipe) id: string,
    @Body() dto: UpdateContactMessageDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    return this.messages.setHandled(id, dto.handled, user.id, req.ip);
  }
}
