import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { PaginationQuery } from '../../../common/pagination/pagination';
import { DocumentStatus, DocumentType } from '../../../generated/prisma/enums';

export class IssueDocumentDto {
  @IsOptional() @IsUUID() paymentId?: string;
  @IsOptional()
  @IsEnum({ BOLETA: 'BOLETA', FACTURA: 'FACTURA' })
  docType?: 'BOLETA' | 'FACTURA';
}

export class VoidDocumentDto {
  /** Billing admite hasta 100 caracteres. */
  @IsString() @IsNotEmpty() @MaxLength(100) reason!: string;
}

export class CreditNoteDto {
  @IsString() @IsNotEmpty() @MaxLength(250) reason!: string;
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100_000_000)
  amountCents!: number;
}

export class DocumentsQuery extends PaginationQuery {
  @IsOptional() @IsEnum(DocumentStatus) status?: DocumentStatus;
  @IsOptional() @IsEnum(DocumentType) docType?: DocumentType;
  @IsOptional() @IsISO8601() from?: string;
  @IsOptional() @IsISO8601() to?: string;
}
