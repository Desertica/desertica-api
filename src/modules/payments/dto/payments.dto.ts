import {
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { PaymentKind } from '../../../generated/prisma/enums';

export class CreatePaymentDto {
  @IsEnum(PaymentKind) kind!: PaymentKind;
}

/** Cuerpo de `createLinkCulqiCharge`: el tipo y el monto los fija el enlace. */
export class LinkCulqiChargeDto {
  /** Token de Culqi.js. Nunca un número de tarjeta. */
  @IsString() @IsNotEmpty() @MaxLength(100) token!: string;
  @IsEmail() @MaxLength(254) email!: string;
  @IsOptional() @IsUUID() paymentId?: string;
  @IsOptional() @IsObject() authentication3DS?: Record<string, unknown>;
}

export class CulqiChargeDto extends LinkCulqiChargeDto {
  @IsEnum(PaymentKind) kind!: PaymentKind;
}
