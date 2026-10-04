import { Global, Module } from '@nestjs/common';
import { AvailabilityService } from './availability.service';
import {
  BlackoutsService,
  PoliciesService,
} from './blackouts-policies.service';
import {
  BlackoutsController,
  CancellationPoliciesController,
  DeparturesController,
  PriceRulesController,
  PublicCatalogController,
  TourRefsController,
} from './catalog.controllers';
import { DeparturesService } from './departures.service';
import { ManifestService } from './manifest.service';
import { PricesService } from './prices.service';
import { SeatsService } from './seats.service';
import { TourRefsService } from './tour-refs.service';

@Global()
@Module({
  controllers: [
    TourRefsController,
    DeparturesController,
    PriceRulesController,
    BlackoutsController,
    CancellationPoliciesController,
    PublicCatalogController,
  ],
  providers: [
    TourRefsService,
    DeparturesService,
    PricesService,
    BlackoutsService,
    PoliciesService,
    AvailabilityService,
    ManifestService,
    SeatsService,
  ],
  exports: [AvailabilityService, SeatsService],
})
export class CatalogModule {}
