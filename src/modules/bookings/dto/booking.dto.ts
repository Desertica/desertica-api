import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { PaginationQuery } from '../../../common/pagination/pagination';
import {
  BookingStatus,
  Currency,
  IdDocType,
  PaymentKind,
} from '../../../generated/prisma/enums';

const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export class CustomerInputDto {
  @IsEmail() @MaxLength(254) email!: string;
  @IsString() @IsNotEmpty() @MaxLength(80) firstName!: string;
  @IsString() @IsNotEmpty() @MaxLength(80) lastName!: string;
  @IsOptional() @IsString() @MaxLength(30) phone?: string;
  @IsOptional() @IsString() @Matches(/^[A-Za-z]{2}$/) country?: string;
  @IsOptional() @IsEnum(IdDocType) idDocType?: IdDocType;
  @IsOptional() @IsString() @MaxLength(20) idDocNumber?: string;
  @IsOptional() @IsString() @MaxLength(10) locale?: string;
}

export class PassengerInputDto {
  @IsString() @IsNotEmpty() @MaxLength(80) firstName!: string;
  @IsString() @IsNotEmpty() @MaxLength(80) lastName!: string;
  @IsOptional() @IsEnum(IdDocType) idDocType?: IdDocType;
  @IsOptional() @IsString() @MaxLength(20) idDocNumber?: string;
  @IsOptional() @Matches(DATE) birthDate?: string;
  @IsOptional() @IsString() @MaxLength(60) nationality?: string;
  @IsOptional() @IsString() @MaxLength(120) emergencyContactName?: string;
  @IsOptional() @IsString() @MaxLength(30) emergencyContactPhone?: string;
}

export class BillingDto {
  @IsEnum({ BOLETA: 'BOLETA', FACTURA: 'FACTURA' }) docType!:
    'BOLETA' | 'FACTURA';
  @IsString() @IsNotEmpty() @MaxLength(200) name!: string;
  @IsEnum(IdDocType) idDocType!: IdDocType;
  @IsString() @IsNotEmpty() @MaxLength(20) idDocNumber!: string;
  @IsOptional() @IsString() @MaxLength(300) address?: string;
  @IsOptional() @IsEmail() @MaxLength(254) email?: string;
}

export class AttributionDto {
  @IsOptional() @IsString() @MaxLength(200) utmSource?: string;
  @IsOptional() @IsString() @MaxLength(200) utmMedium?: string;
  @IsOptional() @IsString() @MaxLength(200) utmCampaign?: string;
  @IsOptional() @IsString() @MaxLength(200) utmContent?: string;
  @IsOptional() @IsString() @MaxLength(200) utmTerm?: string;
  @IsOptional() @IsString() @MaxLength(500) gclid?: string;
  @IsOptional() @IsString() @MaxLength(500) fbclid?: string;
  @IsOptional() @IsString() @MaxLength(500) landingPath?: string;
  @IsOptional() @IsString() @MaxLength(500) referrer?: string;
}

// -------------------------------------------------------------- Público
export class CreateHoldDto {
  @IsUUID() departureId!: string;
  @IsInt() @Min(1) @Max(20) seats!: number;
  @IsOptional() @IsString() @MaxLength(2048) turnstileToken?: string;
}

export class CreatePublicBookingDto {
  @IsString() @IsNotEmpty() @MaxLength(200) holdToken!: string;
  @IsEnum(Currency) currency!: Currency;
  @IsInt() @Min(1) @Max(20) adults!: number;
  @IsOptional() @IsInt() @Min(0) @Max(20) children?: number;
  @ValidateNested() @Type(() => CustomerInputDto) customer!: CustomerInputDto;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => PassengerInputDto)
  passengers?: PassengerInputDto[];
  @ValidateNested() @Type(() => BillingDto) billing!: BillingDto;
  @IsEnum({ FULL: 'FULL', DEPOSIT: 'DEPOSIT' }) paymentKind!:
    'FULL' | 'DEPOSIT';
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @IsUUID(undefined, { each: true })
  acceptedLegalDocumentIds!: string[];
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
  @IsOptional() @IsString() @MaxLength(10) locale?: string;
  @IsOptional()
  @ValidateNested()
  @Type(() => AttributionDto)
  attribution?: AttributionDto;
  @IsOptional() @IsString() @MaxLength(2048) turnstileToken?: string;
}

export class RequestAccessDto {
  @IsString() @IsNotEmpty() @MaxLength(30) reference!: string;
  @IsEmail() @MaxLength(254) email!: string;
}

// ---------------------------------------------------------------- Staff
export class BookingQuery extends PaginationQuery {
  @IsOptional() @IsEnum(BookingStatus) status?: BookingStatus;
  @IsOptional() @IsUUID() departureId?: string;
  @IsOptional() @IsUUID() tourRefId?: string;
  @IsOptional() @IsISO8601() from?: string;
  @IsOptional() @IsISO8601() to?: string;
  @IsOptional() @IsString() @MaxLength(100) q?: string;
}

export class CreateManualBookingDto {
  @IsUUID() departureId!: string;
  @IsEnum(Currency) currency!: Currency;
  @IsInt() @Min(1) @Max(100) adults!: number;
  @IsOptional() @IsInt() @Min(0) @Max(100) children?: number;
  @ValidateNested() @Type(() => CustomerInputDto) customer!: CustomerInputDto;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => PassengerInputDto)
  passengers?: PassengerInputDto[];
  @ValidateNested() @Type(() => BillingDto) billing!: BillingDto;
  @IsOptional() @IsInt() @Min(0) depositCents?: number;
  @IsOptional() @IsInt() @Min(0) overrideTotalCents?: number;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
  @IsOptional() @IsBoolean() sendConfirmation?: boolean;
}

export class UpdateBookingDto {
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
  @IsOptional()
  @ValidateNested()
  @Type(() => CustomerInputDto)
  customer?: CustomerInputDto;
  @IsOptional() @ValidateNested() @Type(() => BillingDto) billing?: BillingDto;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => PassengerInputDto)
  passengers?: PassengerInputDto[];
}

export class CancelBookingDto {
  @IsString() @IsNotEmpty() @MaxLength(500) reason!: string;
  @IsEnum({ POLICY: 'POLICY', FULL: 'FULL', NONE: 'NONE' }) refund!:
    'POLICY' | 'FULL' | 'NONE';
}

export class RescheduleBookingDto {
  @IsUUID() targetDepartureId!: string;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

export class SetBookingStatusDto {
  @IsEnum({ COMPLETED: 'COMPLETED', NO_SHOW: 'NO_SHOW' }) status!:
    'COMPLETED' | 'NO_SHOW';
}

export class CreatePaymentLinkDto {
  @IsEnum(PaymentKind) kind!: PaymentKind;
  @IsOptional() @IsInt() @Min(1) amountCents?: number;
  @IsOptional() @IsInt() @Min(1) @Max(720) expiresInHours?: number;
}

export class ManualPaymentDto {
  @IsEnum({ CASH: 'CASH', TRANSFER: 'TRANSFER', YAPE: 'YAPE', OTHER: 'OTHER' })
  method!: 'CASH' | 'TRANSFER' | 'YAPE' | 'OTHER';
  @IsEnum(PaymentKind) kind!: PaymentKind;
  @IsInt() @Min(1) amountCents!: number;
  @IsEnum(Currency) currency!: Currency;
  @IsOptional() @IsString() @MaxLength(120) reference?: string;
  @IsOptional() @IsISO8601() paidAt?: string;
}

export class CustomerQuery extends PaginationQuery {
  @IsOptional() @IsString() @MaxLength(100) q?: string;
}

export class UpdateCustomerDto extends CustomerInputDto {}
