import {
  Equals,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { PaginationQuery } from '../../../common/pagination/pagination';
import {
  ComplaintGoodType,
  ComplaintKind,
  ComplaintStatus,
  Currency,
  IdDocType,
  LegalDocumentKind,
  WaiverStatus,
} from '../../../generated/prisma/enums';

export class CreateComplaintDto {
  @IsEnum(ComplaintKind) kind!: ComplaintKind;
  @IsEnum(ComplaintGoodType) goodType!: ComplaintGoodType;
  @IsString() @IsNotEmpty() @MaxLength(200) consumerName!: string;
  @IsEnum(IdDocType) idDocType!: IdDocType;
  @IsString() @IsNotEmpty() @MaxLength(20) idDocNumber!: string;
  @IsString() @IsNotEmpty() @MaxLength(300) address!: string;
  @IsEmail() @MaxLength(254) email!: string;
  @IsOptional() @IsString() @MaxLength(30) phone?: string;
  @IsOptional() @IsBoolean() isMinor?: boolean;
  @IsOptional() @IsString() @MaxLength(30) bookingRef?: string;
  @IsOptional() @IsInt() @Min(0) amountCents?: number;
  @IsOptional() @IsEnum(Currency) currency?: Currency;
  @IsString() @IsNotEmpty() @MaxLength(500) description!: string;
  @IsString() @IsNotEmpty() @MaxLength(3000) detail!: string;
  @IsString() @IsNotEmpty() @MaxLength(2000) request!: string;
  @IsOptional() @IsString() @MaxLength(2048) turnstileToken?: string;
}

export class ComplaintQuery extends PaginationQuery {
  @IsOptional() @IsEnum(ComplaintStatus) status?: ComplaintStatus;
}

export class AnswerComplaintDto {
  @IsString() @IsNotEmpty() @MaxLength(5000) answer!: string;
}

export class WaiverQuery {
  @IsOptional() @IsUUID() bookingId?: string;
  @IsOptional() @IsEnum(WaiverStatus) status?: WaiverStatus;
}

export class SignWaiverDto {
  @IsString() @IsNotEmpty() @MaxLength(200) signerName!: string;
  @IsEnum(IdDocType) signerDocType!: IdDocType;
  @IsString() @IsNotEmpty() @MaxLength(20) signerDocNumber!: string;
  @IsOptional() @IsBoolean() onBehalfOfMinor?: boolean;
  @IsOptional() @IsString() @MaxLength(1000) medicalNotes?: string;
  @IsOptional() @IsString() @MaxLength(120) emergencyContactName?: string;
  @IsOptional() @IsString() @MaxLength(30) emergencyContactPhone?: string;
  @Equals(true) accepted!: true;
}

export class ContactMessageDto {
  @IsString() @IsNotEmpty() @MaxLength(120) name!: string;
  @IsEmail() @MaxLength(254) email!: string;
  @IsOptional() @IsString() @MaxLength(30) whatsapp?: string;
  @IsOptional() @IsString() @MaxLength(60) country?: string;
  @IsString() @IsNotEmpty() @MaxLength(3000) message!: string;
  @IsOptional() @IsString() @MaxLength(10) locale?: string;
  @IsOptional() @IsString() @MaxLength(2048) turnstileToken?: string;
}

export class RecordConsentDto {
  @IsString() @Matches(/^[A-Za-z0-9_-]{8,64}$/) anonymousId!: string;
  @IsObject() categories!: Record<string, boolean>;
  @IsInt() @Min(1) @Max(1000) policyVersion!: number;
}

export class PublishLegalDto {
  @IsEnum(LegalDocumentKind) kind!: LegalDocumentKind;
  @IsString() @Matches(/^[a-z]{2}(-[A-Za-z]{2})?$/) locale!: string;
  /** Obligatorio salvo para `WAIVER` (que usa el slug del tour). */
  @IsOptional()
  @IsString()
  @Matches(/^[a-z0-9][a-z0-9-]*$/)
  @MaxLength(100)
  cmsSlug?: string;
  /** Solo para `WAIVER`: el tour cuyo descargo se publica. */
  @IsOptional() @IsUUID() tourRefId?: string;
}

export class LegalDocumentQuery extends PaginationQuery {
  @IsOptional() @IsEnum(LegalDocumentKind) kind?: LegalDocumentKind;
  @IsOptional()
  @IsString()
  @Matches(/^[a-z]{2}(-[A-Za-z]{2})?$/)
  locale?: string;
  @IsOptional() @IsUUID() tourRefId?: string;
}

export class LocaleQuery {
  @IsString() @Matches(/^[a-z]{2}(-[A-Za-z]{2})?$/) locale!: string;
}
