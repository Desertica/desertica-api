import { Global, Module } from '@nestjs/common';
import {
  BlockedIdentitiesController,
  CompanyController,
  ContactMessagesController,
  ReportsController,
} from './admin.controllers';
import { BlockedIdentitiesService } from './blocked-identities.service';
import { CompanyService } from './company.service';
import { ContactMessagesService } from './contact-messages.service';
import { ReportsService } from './reports.service';

@Global()
@Module({
  controllers: [
    CompanyController,
    BlockedIdentitiesController,
    ReportsController,
    ContactMessagesController,
  ],
  providers: [
    CompanyService,
    BlockedIdentitiesService,
    ReportsService,
    ContactMessagesService,
  ],
  exports: [BlockedIdentitiesService],
})
export class AdminModule {}
