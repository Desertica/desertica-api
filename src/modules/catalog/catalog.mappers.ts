import {
  Blackout,
  CancellationPolicy,
  Departure,
  PriceRule,
  TourRef,
} from '../../generated/prisma/client';
import { dbDateToString } from '../../common/time/lima';

export const toTourRefDto = (t: TourRef) => ({
  id: t.id,
  slug: t.slug,
  title: t.title,
  durationHours: t.durationHours,
  active: t.active,
  requiresWaiver: t.requiresWaiver,
  minAge: t.minAge,
  minHeightCm: t.minHeightCm,
  defaultCapacity: t.defaultCapacity,
  cancellationPolicyId: t.cancellationPolicyId,
  cmsSyncedAt: t.cmsSyncedAt,
});

export const toDepartureDto = (
  d: Departure,
  counts: { sold: number; held: number } = { sold: 0, held: 0 },
) => ({
  id: d.id,
  tourRefId: d.tourRefId,
  startsAt: d.startsAt,
  capacity: d.capacity,
  seatsSold: counts.sold,
  seatsHeld: counts.held,
  format: d.format,
  language: d.language,
  status: d.status,
  meetingPoint: d.meetingPoint,
  guideName: d.guideName,
  vehicleNote: d.vehicleNote,
  notes: d.notes,
  cutoffMinutes: d.cutoffMinutes,
});

export const toPriceRuleDto = (r: PriceRule) => ({
  id: r.id,
  tourRefId: r.tourRefId,
  currency: r.currency,
  format: r.format,
  unit: r.unit,
  adultCents: r.adultCents,
  childCents: r.childCents,
  groupCents: r.groupCents,
  minPeople: r.minPeople,
  maxPeople: r.maxPeople,
  validFrom: r.validFrom ? dbDateToString(r.validFrom) : null,
  validTo: r.validTo ? dbDateToString(r.validTo) : null,
  priority: r.priority,
  active: r.active,
});

export const toBlackoutDto = (b: Blackout) => ({
  id: b.id,
  tourRefId: b.tourRefId,
  startsOn: dbDateToString(b.startsOn),
  endsOn: dbDateToString(b.endsOn),
  reason: b.reason ?? undefined,
});

export const toPolicyDto = (p: CancellationPolicy) => ({
  id: p.id,
  key: p.key,
  name: p.name,
  version: p.version,
  active: p.active,
  tiers: p.tiers as { hoursBefore: number; refundPercent: number }[],
  depositRefundable: p.depositRefundable,
});
