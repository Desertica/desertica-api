import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { PaginationQuery } from '../../../common/pagination/pagination';

export const SunatEnvironmentInput = { BETA: 'BETA', PRODUCTION: 'PRODUCTION' };
export const DocumentTypeInput = {
  BOLETA: 'BOLETA',
  FACTURA: 'FACTURA',
  NOTA_CREDITO: 'NOTA_CREDITO',
  NOTA_DEBITO: 'NOTA_DEBITO',
};

export class CompanyDto {
  @IsString() @Matches(/^\d{11}$/) ruc!: string;
  @IsString() @IsNotEmpty() @MaxLength(200) legalName!: string;
  @IsOptional() @IsString() @MaxLength(200) tradeName?: string;
  @IsString() @IsNotEmpty() @MaxLength(300) fiscalAddress!: string;
  @IsOptional() @IsString() @Matches(/^\d{6}$/) ubigeo?: string;
  /** Entre 0 y 1 con hasta cuatro decimales, p. ej. `0.1800`. */
  @IsOptional()
  @IsString()
  @Matches(/^(0(\.\d{1,4})?|1(\.0{1,4})?)$/)
  igvRate?: string;
  @IsOptional() @IsEnum(SunatEnvironmentInput) environment?:
    'BETA' | 'PRODUCTION';
}

export class CreateSeriesDto {
  @IsEnum(DocumentTypeInput) docType!:
    'BOLETA' | 'FACTURA' | 'NOTA_CREDITO' | 'NOTA_DEBITO';
  @IsString() @Matches(/^[BFE][A-Z0-9]{3}$/) prefix!: string;
  @IsOptional() @IsInt() @Min(1) @Max(99_999_999) nextNumber?: number;
}

export class CreateBlockedIdentityDto {
  @IsEnum({ EMAIL: 'EMAIL', IP: 'IP' }) kind!: 'EMAIL' | 'IP';
  @IsString() @IsNotEmpty() @MaxLength(254) value!: string;
  @IsOptional() @IsString() @MaxLength(300) reason?: string;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export class DashboardQuery {
  @IsString() @Matches(DATE) from!: string;
  @IsString() @Matches(DATE) to!: string;
}

export class SalesReportQuery extends DashboardQuery {
  @IsOptional()
  @IsEnum({ day: 'day', tour: 'tour', provider: 'provider' })
  groupBy?: 'day' | 'tour' | 'provider';
  @IsOptional() @IsEnum({ json: 'json', csv: 'csv' }) format?: 'json' | 'csv';
}

export class ContactMessageQuery extends PaginationQuery {
  @IsOptional()
  // Con la conversión implícita, "false" llegaría como `true`: se lee el valor crudo.
  @Transform(({ obj }: { obj: { handled?: unknown } }) =>
    obj.handled === 'true'
      ? true
      : obj.handled === 'false'
        ? false
        : obj.handled,
  )
  @IsBoolean()
  handled?: boolean;
}

export class UpdateContactMessageDto {
  // Sin conversión implícita: "yes" o "false" como texto no deben pasar por booleano.
  @Transform(({ obj }: { obj: { handled?: unknown } }) => obj.handled)
  @IsBoolean()
  handled!: boolean;
}

export class CancelDepartureDto {
  @IsString() @IsNotEmpty() @MaxLength(500) reason!: string;
  @IsEnum({
    REFUND: 'REFUND',
    RESCHEDULE: 'RESCHEDULE',
    CLIENT_CHOICE: 'CLIENT_CHOICE',
  })
  resolution!: 'REFUND' | 'RESCHEDULE' | 'CLIENT_CHOICE';
  @IsOptional() @IsUUID() targetDepartureId?: string;
}
