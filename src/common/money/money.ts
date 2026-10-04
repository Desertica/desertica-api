/**
 * Aritmética de dinero. Todo son enteros en la unidad menor (`*Cents`) y el
 * monto siempre incluye IGV. No usar `number` con decimales para dinero.
 *
 * Redondeo: mitad hacia arriba (half-up) sobre enteros no negativos, hecho con
 * aritmética entera para no depender del punto flotante.
 */

export type Cents = number;

/** Tasa de IGV vigente por defecto, en puntos base (18 % = 1800). */
export const DEFAULT_IGV_BPS = 1800;

export class MoneyError extends Error {}

export function assertCents(value: number, label = 'cents'): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new MoneyError(`${label} must be a non-negative safe integer`);
  }
}

/** Divide `n / d` redondeando a la mitad hacia arriba. Solo enteros no negativos. */
export function roundDiv(n: number, d: number): number {
  if (!Number.isSafeInteger(n) || n < 0) throw new MoneyError('n invalid');
  if (!Number.isSafeInteger(d) || d <= 0) throw new MoneyError('d invalid');
  const q = Math.floor(n / d);
  const r = n - q * d;
  return r * 2 >= d ? q + 1 : q;
}

/** Convierte una tasa decimal (`"0.1800"`, `0.18`) a puntos base (`1800`). */
export function rateToBps(rate: string | number): number {
  const text = typeof rate === 'number' ? rate.toFixed(4) : rate.trim();
  if (!/^\d+(\.\d+)?$/.test(text)) throw new MoneyError('rate invalid');
  const [int, frac = ''] = text.split('.');
  const bps = Number(int) * 10000 + Number((frac + '0000').slice(0, 4));
  if (!Number.isSafeInteger(bps)) throw new MoneyError('rate invalid');
  return bps;
}

export interface IgvBreakdown {
  totalCents: Cents;
  taxableCents: Cents;
  igvCents: Cents;
}

/**
 * Separa un total con IGV incluido en base imponible e IGV.
 * `taxable = round(total / (1 + rate))`; `igv = total - taxable`, de modo que
 * `taxable + igv === total` siempre.
 */
export function splitIgv(
  totalCents: Cents,
  rateBps: number = DEFAULT_IGV_BPS,
): IgvBreakdown {
  assertCents(totalCents, 'totalCents');
  if (!Number.isSafeInteger(rateBps) || rateBps < 0) {
    throw new MoneyError('rateBps invalid');
  }
  const taxableCents = roundDiv(totalCents * 10000, 10000 + rateBps);
  return { totalCents, taxableCents, igvCents: totalCents - taxableCents };
}

/** `percent` % de `cents`, con `percent` entero o con hasta 2 decimales. */
export function percentOf(cents: Cents, percent: number): Cents {
  assertCents(cents, 'cents');
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    throw new MoneyError('percent must be between 0 and 100');
  }
  const hundredths = Math.round(percent * 100); // centésimas de punto porcentual
  return roundDiv(cents * hundredths, 10000);
}

/** Depósito como porcentaje del total, nunca mayor que el total. */
export function computeDeposit(totalCents: Cents, percent: number): Cents {
  return Math.min(totalCents, percentOf(totalCents, percent));
}

// ---------------------------------------------------------------- Precios

export interface PriceRuleAmounts {
  unit: 'PER_PERSON' | 'PER_GROUP';
  adultCents: Cents;
  childCents?: Cents | null;
  groupCents?: Cents | null;
}

export interface PriceLine {
  label: 'adult' | 'child' | 'group';
  quantity: number;
  unitCents: Cents;
  totalCents: Cents;
}

export interface PriceResult {
  totalCents: Cents;
  lines: PriceLine[];
}

/**
 * Total de una reserva según la regla. Por persona: adultos y niños (el niño
 * paga como adulto si la regla no define precio de niño). Por grupo: tarifa
 * fija sin importar cuántas personas.
 */
export function priceBooking(
  rule: PriceRuleAmounts,
  adults: number,
  children = 0,
): PriceResult {
  if (!Number.isInteger(adults) || adults < 1) {
    throw new MoneyError('adults must be >= 1');
  }
  if (!Number.isInteger(children) || children < 0) {
    throw new MoneyError('children must be >= 0');
  }
  if (rule.unit === 'PER_GROUP') {
    if (rule.groupCents == null) throw new MoneyError('groupCents missing');
    assertCents(rule.groupCents, 'groupCents');
    return {
      totalCents: rule.groupCents,
      lines: [
        {
          label: 'group',
          quantity: 1,
          unitCents: rule.groupCents,
          totalCents: rule.groupCents,
        },
      ],
    };
  }
  assertCents(rule.adultCents, 'adultCents');
  const lines: PriceLine[] = [
    {
      label: 'adult',
      quantity: adults,
      unitCents: rule.adultCents,
      totalCents: adults * rule.adultCents,
    },
  ];
  if (children > 0) {
    const unit = rule.childCents ?? rule.adultCents;
    assertCents(unit, 'childCents');
    lines.push({
      label: 'child',
      quantity: children,
      unitCents: unit,
      totalCents: children * unit,
    });
  }
  const totalCents = lines.reduce((sum, l) => sum + l.totalCents, 0);
  if (!Number.isSafeInteger(totalCents)) throw new MoneyError('total overflow');
  return { totalCents, lines };
}

// ---------------------------------------------------------- Cancelación

export interface CancellationTier {
  hoursBefore: number;
  refundPercent: number;
}

/** Ordena de mayor a menor `hoursBefore` (copia). */
export function sortTiers(tiers: CancellationTier[]): CancellationTier[] {
  return [...tiers].sort((a, b) => b.hoursBefore - a.hoursBefore);
}

/**
 * Tramo aplicable: el de mayor `hoursBefore` que todavía se cumple, es decir,
 * cuando faltan al menos `hoursBefore` horas para la salida. Si no se cumple
 * ninguno no corresponde reembolso (`null`).
 */
export function selectRefundTier(
  tiers: CancellationTier[],
  hoursUntilDeparture: number,
): CancellationTier | null {
  for (const tier of sortTiers(tiers)) {
    if (hoursUntilDeparture >= tier.hoursBefore) return tier;
  }
  return null;
}

export interface RefundInput {
  paidCents: Cents;
  refundedCents?: Cents;
  depositCents?: Cents | null;
  depositRefundable: boolean;
  tiers: CancellationTier[];
  hoursUntilDeparture: number;
}

export interface RefundResult {
  refundCents: Cents;
  retainedCents: Cents;
  refundPercent: number;
  tier: CancellationTier | null;
}

/**
 * Reembolso por política. Base reembolsable = lo pagado (menos lo ya
 * reembolsado) y, si el depósito no es reembolsable, menos el depósito.
 * Resultado = `refundPercent` % de la base, nunca más de lo disponible.
 */
export function computeRefund(input: RefundInput): RefundResult {
  const paid = input.paidCents;
  const already = input.refundedCents ?? 0;
  assertCents(paid, 'paidCents');
  assertCents(already, 'refundedCents');
  if (already > paid) throw new MoneyError('refunded exceeds paid');
  const available = paid - already;
  const tier = selectRefundTier(input.tiers, input.hoursUntilDeparture);
  const refundPercent = tier?.refundPercent ?? 0;

  const locked = input.depositRefundable
    ? 0
    : Math.min(input.depositCents ?? 0, paid);
  const base = Math.max(0, paid - locked - already);
  const refundCents = Math.min(available, percentOf(base, refundPercent));
  return {
    refundCents,
    retainedCents: available - refundCents,
    refundPercent,
    tier,
  };
}

// ------------------------------------------------------- Reprogramación

export interface PriceAdjustment {
  type: 'CHARGE' | 'REFUND' | 'NONE';
  amountCents: Cents;
}

/** Diferencia entre el total nuevo y el anterior al mover una reserva. */
export function priceDifference(
  oldTotalCents: Cents,
  newTotalCents: Cents,
): PriceAdjustment {
  assertCents(oldTotalCents, 'oldTotalCents');
  assertCents(newTotalCents, 'newTotalCents');
  if (newTotalCents > oldTotalCents) {
    return { type: 'CHARGE', amountCents: newTotalCents - oldTotalCents };
  }
  if (newTotalCents < oldTotalCents) {
    return { type: 'REFUND', amountCents: oldTotalCents - newTotalCents };
  }
  return { type: 'NONE', amountCents: 0 };
}

/** Saldo pendiente de una reserva (nunca negativo). */
export function pendingCents(
  totalCents: Cents,
  paidCents: Cents,
  refundedCents = 0,
): Cents {
  return Math.max(0, totalCents - (paidCents - refundedCents));
}
