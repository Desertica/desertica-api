import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { PaginationQuery } from '../../common/pagination/pagination';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, Public, RequirePermission } from '../auth/decorators';
import { AvailabilityService } from './availability.service';
import {
  BlackoutsService,
  PoliciesService,
} from './blackouts-policies.service';
import { DeparturesService } from './departures.service';
import {
  AvailabilityQuery,
  BlackoutInputDto,
  CancellationPolicyInputDto,
  CreateDepartureDto,
  DepartureQuery,
  PriceRuleInputDto,
  PriceRuleQuery,
  QuoteRequestDto,
  UpdateDepartureDto,
  UpdateTourRefDto,
} from './dto/catalog.dto';
import { ManifestService } from './manifest.service';
import { PricesService } from './prices.service';
import { TourRefsService } from './tour-refs.service';

@Controller('tour-refs')
export class TourRefsController {
  constructor(private readonly tourRefs: TourRefsService) {}

  @Get()
  @RequirePermission('catalog:read')
  list(@Query() q: PaginationQuery) {
    return this.tourRefs.list(q);
  }

  // Declarado antes de `:id` para que "sync" no se interprete como id.
  @Post('sync')
  @HttpCode(200)
  @RequirePermission('catalog:write')
  sync(@CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.tourRefs.sync(user.id, req.ip);
  }

  @Get(':id')
  @RequirePermission('catalog:read')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.tourRefs.get(id);
  }

  @Patch(':id')
  @RequirePermission('catalog:write')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTourRefDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    return this.tourRefs.update(id, dto, user.id, req.ip);
  }
}

@Controller('departures')
export class DeparturesController {
  constructor(
    private readonly departures: DeparturesService,
    private readonly manifest: ManifestService,
  ) {}

  @Get()
  @RequirePermission('departures:read')
  list(@Query() q: DepartureQuery) {
    return this.departures.list(q);
  }

  @Post()
  @RequirePermission('departures:write')
  create(
    @Body() dto: CreateDepartureDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    return this.departures.create(dto, user.id, req.ip);
  }

  @Get(':id')
  @RequirePermission('departures:read')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.departures.get(id);
  }

  @Patch(':id')
  @RequirePermission('departures:write')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDepartureDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    return this.departures.update(id, dto, user.id, req.ip);
  }

  @Get(':id/manifest')
  @RequirePermission('departures:read')
  getManifest(@Param('id', ParseUUIDPipe) id: string) {
    return this.manifest.forDeparture(id);
  }
}

@Controller('price-rules')
export class PriceRulesController {
  constructor(private readonly prices: PricesService) {}

  @Get()
  @RequirePermission('prices:read')
  list(@Query() q: PriceRuleQuery) {
    return this.prices.list(q);
  }

  @Post()
  @RequirePermission('prices:write')
  create(
    @Body() dto: PriceRuleInputDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    return this.prices.create(dto, user.id, req.ip);
  }

  @Put(':id')
  @RequirePermission('prices:write')
  replace(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PriceRuleInputDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    return this.prices.replace(id, dto, user.id, req.ip);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('prices:write')
  async deactivate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    await this.prices.deactivate(id, user.id, req.ip);
  }
}

@Controller('blackouts')
export class BlackoutsController {
  constructor(private readonly blackouts: BlackoutsService) {}

  @Get()
  @RequirePermission('departures:read')
  list() {
    return this.blackouts.list();
  }

  @Post()
  @RequirePermission('departures:write')
  create(
    @Body() dto: BlackoutInputDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    return this.blackouts.create(dto, user.id, req.ip);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('departures:write')
  async delete(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    await this.blackouts.delete(id, user.id, req.ip);
  }
}

@Controller('cancellation-policies')
export class CancellationPoliciesController {
  constructor(private readonly policies: PoliciesService) {}

  @Get()
  @RequirePermission('catalog:read')
  list() {
    return this.policies.list();
  }

  @Post()
  @RequirePermission('catalog:write')
  create(
    @Body() dto: CancellationPolicyInputDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    return this.policies.create(dto, user.id, req.ip);
  }
}

@Public()
@Controller('public')
export class PublicCatalogController {
  constructor(private readonly availability: AvailabilityService) {}

  @Get('tours/:slug/availability')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  getAvailability(@Param('slug') slug: string, @Query() q: AvailabilityQuery) {
    return this.availability.forMonth(slug, q);
  }

  @Post('quotes')
  @HttpCode(200)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  createQuote(@Body() dto: QuoteRequestDto) {
    return this.availability.quote(dto);
  }
}
