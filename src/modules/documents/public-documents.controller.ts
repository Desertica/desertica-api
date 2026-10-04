import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { verifyLink } from '../../common/signed-link';
import { rateLimit } from '../../common/throttle';
import { UuidPipe } from '../../common/pipes/id-pipes';
import { EnvVars } from '../../config/env.validation';
import { PrismaService } from '../../prisma/prisma.service';
import { Public } from '../auth/decorators';
import { DocumentsService } from './documents.service';

/**
 * Descarga del PDF por el cliente con un enlace firmado y de corta vida (el
 * que trae `PublicBooking.documents`). Un enlace inválido, vencido o de un
 * comprobante que no es boleta ni factura responde siempre 404.
 */
@Public()
@Controller('public/documents')
export class PublicDocumentsController {
  constructor(
    private readonly documents: DocumentsService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<EnvVars, true>,
  ) {}

  @Get(':id/pdf')
  @Throttle(rateLimit(30, 60_000))
  async pdf(
    @Param('id', UuidPipe) id: string,
    @Query('exp') exp: string | undefined,
    @Query('sig') sig: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const notFound = new NotFoundException('Document not found');
    const secret = this.config.get('JWT_ACCESS_SECRET', { infer: true });
    if (
      !exp ||
      !sig ||
      !verifyLink(secret, `document:${id}`, Number(exp), sig)
    ) {
      throw notFound;
    }
    const doc = await this.prisma.document.findUnique({
      where: { id },
      select: { docType: true, status: true },
    });
    if (
      !doc ||
      (doc.docType !== 'BOLETA' && doc.docType !== 'FACTURA') ||
      (doc.status !== 'ISSUED' && doc.status !== 'ACCEPTED')
    ) {
      throw notFound;
    }
    const file = await this.documents.file(id, 'pdf');
    res.setHeader('Content-Type', file.contentType);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${file.filename}"`,
    );
    res.setHeader('Cache-Control', 'private, no-store');
    return new StreamableFile(file.data);
  }
}
