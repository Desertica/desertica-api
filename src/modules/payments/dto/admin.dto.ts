import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { PaginationQuery } from '../../../common/pagination/pagination';
import {
  DisputeStatus,
  PaymentProvider,
  PaymentStatus,
} from '../../../generated/prisma/enums';

export class CreateRefundDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100_000_000)
  amountCents!: number;
  @IsString() @IsNotEmpty() @MaxLength(500) reason!: string;
}

export class PaymentsQuery extends PaginationQuery {
  @IsOptional() @IsEnum(PaymentStatus) status?: PaymentStatus;
  @IsOptional() @IsEnum(PaymentProvider) provider?: PaymentProvider;
  @IsOptional() @IsISO8601() from?: string;
  @IsOptional() @IsISO8601() to?: string;
}

export class DisputesQuery extends PaginationQuery {
  @IsOptional() @IsEnum(DisputeStatus) status?: DisputeStatus;
}

export class UpdateDisputeDto {
  @IsOptional() @IsEnum(DisputeStatus) status?: DisputeStatus;
  @IsOptional() @IsString() @MaxLength(4000) notes?: string;
}
