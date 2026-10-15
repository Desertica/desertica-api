import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { PaginationQuery } from '../../../common/pagination/pagination';
import {
  Currency,
  DepartureStatus,
  PriceUnit,
  TourFormat,
} from '../../../generated/prisma/enums';

const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

// ------------------------------------------------------------- Tour refs
export class UpdateTourRefDto {
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsBoolean() requiresWaiver?: boolean;
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(0)
  @Max(120)
  minAge?: number | null;
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(0)
  @Max(250)
  minHeightCm?: number | null;
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(1)
  @Max(1000)
  defaultCapacity?: number | null;
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  cancellationPolicyId?: string | null;
}

// ------------------------------------------------------------ Departures
export class DepartureQuery extends PaginationQuery {
  @IsOptional() @IsUUID() tourRefId?: string;
  @IsOptional() @IsISO8601() from?: string;
  @IsOptional() @IsISO8601() to?: string;
  @IsOptional() @IsEnum(DepartureStatus) status?: DepartureStatus;
}

export class RepeatDto {
  @Matches(DATE) until!: string;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(7)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  weekdays!: number[];
}

export class CreateDepartureDto {
  @IsUUID() tourRefId!: string;
  @IsISO8601() startsAt!: string;
  @IsInt() @Min(1) @Max(1000) capacity!: number;
  @IsOptional() @IsEnum(TourFormat) format?: TourFormat;
  @IsOptional() @IsString() @MaxLength(10) language?: string;
  @IsOptional() @IsString() @MaxLength(200) meetingPoint?: string;
  @IsOptional() @IsString() @MaxLength(120) guideName?: string;
  @IsOptional() @IsString() @MaxLength(200) vehicleNote?: string;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
  @IsOptional() @IsInt() @Min(0) @Max(10080) cutoffMinutes?: number;
  @IsOptional() @ValidateNested() @Type(() => RepeatDto) repeat?: RepeatDto;
}

export class UpdateDepartureDto {
  @IsOptional() @IsISO8601() startsAt?: string;
  @IsOptional() @IsInt() @Min(1) @Max(1000) capacity?: number;
  @IsOptional() @IsEnum({ OPEN: 'OPEN', CLOSED: 'CLOSED' }) status?:
    'OPEN' | 'CLOSED';
  @IsOptional() @IsString() @MaxLength(200) meetingPoint?: string;
  @IsOptional() @IsString() @MaxLength(120) guideName?: string;
  @IsOptional() @IsString() @MaxLength(200) vehicleNote?: string;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
  @IsOptional() @IsInt() @Min(0) @Max(10080) cutoffMinutes?: number;
}

// ----------------------------------------------------------- Price rules
export class PriceRuleQuery extends PaginationQuery {
  @IsOptional() @IsUUID() tourRefId?: string;
}

export class PriceRuleInputDto {
  @IsUUID() tourRefId!: string;
  @IsEnum(Currency) currency!: Currency;
  @IsOptional() @IsEnum(TourFormat) format?: TourFormat;
  @IsOptional() @IsEnum(PriceUnit) unit?: PriceUnit;
  @IsInt() @Min(0) adultCents!: number;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(0) childCents?:
    number | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(0) groupCents?:
    number | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(1) minPeople?:
    number | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(1) maxPeople?:
    number | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @Matches(DATE) validFrom?:
    string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @Matches(DATE) validTo?:
    string | null;
  @IsOptional() @IsInt() priority?: number;
  @IsOptional() @IsBoolean() active?: boolean;
}

// -------------------------------------------------------------- Blackouts
export class BlackoutInputDto {
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID() tourRefId?:
    string | null;
  @Matches(DATE) startsOn!: string;
  @Matches(DATE) endsOn!: string;
  @IsOptional() @IsString() @MaxLength(200) reason?: string;
}

// ------------------------------------------------------------- Policies
export class TierDto {
  @IsInt() @Min(0) @Max(8760) hoursBefore!: number;
  @IsInt() @Min(0) @Max(100) refundPercent!: number;
}

export class CancellationPolicyInputDto {
  @IsString() @MaxLength(60) @Matches(/^[a-z0-9][a-z0-9-]*$/) key!: string;
  @IsString() @MaxLength(120) name!: string;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => TierDto)
  tiers!: TierDto[];
  @IsOptional() @IsBoolean() depositRefundable?: boolean;
}

// ---------------------------------------------------------------- Público
export class AvailabilityQuery {
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/) month!: string;
  @IsEnum(Currency) currency!: Currency;
  @IsOptional() @IsEnum(TourFormat) format?: TourFormat;
  @IsOptional() @IsString() @MaxLength(10) language?: string;
}

export class QuoteRequestDto {
  @IsUUID() departureId!: string;
  @IsInt() @Min(1) @Max(100) adults!: number;
  @IsOptional() @IsInt() @Min(0) @Max(100) children?: number;
  @IsEnum(Currency) currency!: Currency;
}
