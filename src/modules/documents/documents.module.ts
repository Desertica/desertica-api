import { Module } from '@nestjs/common';
import { DocumentWorker } from './document-worker.service';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { PublicDocumentsController } from './public-documents.controller';

@Module({
  controllers: [DocumentsController, PublicDocumentsController],
  providers: [DocumentsService, DocumentWorker],
  exports: [DocumentsService, DocumentWorker],
})
export class DocumentsModule {}
