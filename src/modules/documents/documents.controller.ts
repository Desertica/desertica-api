import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseEnumPipe,
  Post,
  Query,
  Res,
  StreamableFile,
} from '@nestjs/common';
import type { Response } from 'express';
import { UuidPipe } from '../../common/pipes/id-pipes';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, RequirePermission } from '../auth/decorators';
import {
  CreditNoteDto,
  DocumentsQuery,
  IssueDocumentDto,
  VoidDocumentDto,
} from './dto/documents.dto';
import { DocumentsService, type FileKind } from './documents.service';

const KINDS = { xml: 'xml', cdr: 'cdr', pdf: 'pdf' } as const;

@Controller()
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Post('bookings/:id/documents')
  @HttpCode(202)
  @RequirePermission('documents:issue')
  async issue(
    @Param('id', UuidPipe) id: string,
    @Body() dto: IssueDocumentDto,
    @Headers('idempotency-key') key: string | undefined,
    @CurrentUser() user: AuthUser,
  ) {
    const result = await this.documents.issue(id, dto, user, {
      idempotencyKey: key,
    });
    return result.body;
  }

  @Get('documents')
  @RequirePermission('documents:read')
  list(@Query() q: DocumentsQuery) {
    return this.documents.list(q);
  }

  @Get('documents/:id')
  @RequirePermission('documents:read')
  get(@Param('id', UuidPipe) id: string) {
    return this.documents.get(id);
  }

  @Post('documents/:id/retry')
  @HttpCode(202)
  @RequirePermission('documents:issue')
  retry(@Param('id', UuidPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.documents.retry(id, user);
  }

  @Post('documents/:id/void')
  @HttpCode(202)
  @RequirePermission('documents:void')
  void(
    @Param('id', UuidPipe) id: string,
    @Body() dto: VoidDocumentDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.documents.void(id, dto, user);
  }

  @Post('documents/:id/credit-note')
  @HttpCode(202)
  @RequirePermission('documents:void')
  creditNote(
    @Param('id', UuidPipe) id: string,
    @Body() dto: CreditNoteDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.documents.createCreditNote(id, dto, user);
  }

  @Get('documents/:id/files/:kind')
  @RequirePermission('documents:read')
  async download(
    @Param('id', UuidPipe) id: string,
    @Param('kind', new ParseEnumPipe(KINDS)) kind: FileKind,
    @Res({ passthrough: true }) res: Response,
  ) {
    const file = await this.documents.file(id, kind);
    // Las cabeceras van aquí y no como decorador: un error (404) debe seguir siendo JSON.
    res.setHeader('Content-Type', file.contentType);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${file.filename}"`,
    );
    res.setHeader('Cache-Control', 'no-store');
    return new StreamableFile(file.data);
  }
}
