import { Global, Module } from '@nestjs/common';
import { CmsClient } from './cms.client';

@Global()
@Module({ providers: [CmsClient], exports: [CmsClient] })
export class CmsModule {}
