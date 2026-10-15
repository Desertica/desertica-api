import { Global, Module } from '@nestjs/common';
import { CmsClient } from './cms.client';
import { TourTitlesService } from './tour-titles.service';

@Global()
@Module({
  providers: [CmsClient, TourTitlesService],
  exports: [CmsClient, TourTitlesService],
})
export class CmsModule {}
