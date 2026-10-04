import { Global, Module } from '@nestjs/common';
import { BackgroundQueue } from './background-queue';

@Global()
@Module({ providers: [BackgroundQueue], exports: [BackgroundQueue] })
export class QueueModule {}
