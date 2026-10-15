import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { addDays } from '../../common/time/lima';
import { EnvVars } from '../../config/env.validation';
import { PrismaService } from '../../prisma/prisma.service';

export interface ExchangeRate {
  /** USD→PEN con 4 decimales, p. ej. `3.7500`. */
  rate: string;
  source: 'setting-date' | 'setting' | 'fallback';
}

const RATE = /^\d+(\.\d{1,4})?$/;
const fix4 = (value: string) => Number(value).toFixed(4);

/**
 * Tipo de cambio SUNAT (venta) para comprobantes en USD. Orden de búsqueda:
 * 1. `Setting.exchangeRates`: `{ "2026-10-04": "3.7500", ... }`, la fecha pedida
 *    o la más reciente de los 7 días anteriores (fines de semana y feriados).
 * 2. `Setting.exchangeRateUsdPen`: un valor único vigente.
 * 3. `EXCHANGE_RATE_FALLBACK` (valor de respaldo, `3.7500` por defecto): se
 *    avisa en el log; no es el tipo de cambio oficial del día.
 * El contador debe confirmar cuál publicación de SUNAT corresponde a cada comprobante.
 */
@Injectable()
export class ExchangeRateService {
  private readonly logger = new Logger(ExchangeRateService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<EnvVars, true>,
  ) {}

  async rateFor(date: string): Promise<ExchangeRate> {
    const byDate = await this.prisma.setting.findUnique({
      where: { key: 'exchangeRates' },
    });
    if (byDate?.value && typeof byDate.value === 'object') {
      const table = byDate.value as Record<string, unknown>;
      for (let back = 0; back <= 7; back++) {
        const v = table[addDays(date, -back)];
        if (typeof v === 'string' && RATE.test(v)) {
          return { rate: fix4(v), source: 'setting-date' };
        }
      }
    }
    const single = await this.prisma.setting.findUnique({
      where: { key: 'exchangeRateUsdPen' },
    });
    const value =
      typeof single?.value === 'number' ? String(single.value) : single?.value;
    if (typeof value === 'string' && RATE.test(value)) {
      return { rate: fix4(value), source: 'setting' };
    }
    this.logger.warn(
      `No exchange rate loaded for ${date}: using the fallback value`,
    );
    return {
      rate: fix4(this.config.get('EXCHANGE_RATE_FALLBACK', { infer: true })),
      source: 'fallback',
    };
  }
}
