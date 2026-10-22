import { Global, Module } from '@nestjs/common';
import { ComplaintsService } from './complaints.service';
import {
  ComplaintsController,
  PublicComplianceController,
  StaffComplianceController,
} from './compliance.controllers';
import { LegalService } from './legal.service';
import { PublicComplianceService } from './public-compliance.service';
import { WaiversService } from './waivers.service';

@Global()
@Module({
  controllers: [
    ComplaintsController,
    StaffComplianceController,
    PublicComplianceController,
  ],
  providers: [
    ComplaintsService,
    WaiversService,
    LegalService,
    PublicComplianceService,
  ],
  exports: [LegalService],
})
export class ComplianceModule {}
