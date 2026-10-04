import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/** Ajustes operativos con su valor por defecto y su rango válido. */
export const SETTING_DEFINITIONS = {
  /** % del total que se cobra como depósito cuando el cliente elige pagar en dos partes. */
  depositPercent: { default: 30, min: 0, max: 100 },
  /** Minutos que dura un bloqueo de cupo mientras el cliente completa el pago. */
  holdMinutes: { default: 15, min: 1, max: 120 },
  /** Tope de reembolso de un operador sin `payments:refund-any`, en centavos. */
  operatorRefundLimitCents: { default: 20000, min: 0, max: 100_000_000 },
  /** Días de plazo legal para responder un reclamo. */
  complaintDueDays: { default: 15, min: 1, max: 60 },
} as const;

export type SettingKey = keyof typeof SETTING_DEFINITIONS;
export type Settings = Record<SettingKey, number>;

@Injectable()
export class SettingsService {
  constructor(private readonly prisma: PrismaService) {}

  async getAll(): Promise<Settings & Record<string, unknown>> {
    const rows = await this.prisma.setting.findMany();
    const result: Record<string, unknown> = {};
    for (const [key, def] of Object.entries(SETTING_DEFINITIONS)) {
      result[key] = def.default;
    }
    for (const row of rows) result[row.key] = row.value;
    return result as Settings & Record<string, unknown>;
  }

  async getNumber(key: SettingKey): Promise<number> {
    const row = await this.prisma.setting.findUnique({ where: { key } });
    return typeof row?.value === 'number'
      ? row.value
      : SETTING_DEFINITIONS[key].default;
  }

  /** Guarda las claves enviadas; las numéricas conocidas se validan por rango. */
  async save(input: Record<string, unknown>) {
    for (const [key, value] of Object.entries(input)) {
      const def = (
        SETTING_DEFINITIONS as Record<
          string,
          { min: number; max: number } | undefined
        >
      )[key];
      if (
        def &&
        (typeof value !== 'number' ||
          !Number.isInteger(value) ||
          value < def.min ||
          value > def.max)
      ) {
        throw new UnprocessableEntityException(
          `${key} must be an integer between ${def.min} and ${def.max}`,
        );
      }
    }
    await this.prisma.$transaction(
      Object.entries(input).map(([key, value]) =>
        this.prisma.setting.upsert({
          where: { key },
          update: { value: value as Prisma.InputJsonValue },
          create: { key, value: value as Prisma.InputJsonValue },
        }),
      ),
    );
    return this.getAll();
  }
}
