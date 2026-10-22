import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { buildZip, type ZipEntry } from '../../common/zip/zip';
import { PrismaService } from '../../prisma/prisma.service';
import {
  DOCUMENT_STORAGE,
  type DocumentStorage,
} from '../billing/document-storage';

const json = (value: unknown) =>
  Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8');
const text = (value: string) => Buffer.from(value, 'utf8');
const slug = (value: string) =>
  value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'x';

/**
 * Paquete de evidencia de una disputa (ZIP) para responder al contracargo:
 * confirmación de la reserva, pagos, políticas que aceptó el cliente (con el
 * texto exacto de ese momento), descargos firmados, manifiesto y comprobantes.
 * Solo lee; no cambia nada.
 */
@Injectable()
export class EvidenceService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(DOCUMENT_STORAGE) private readonly storage: DocumentStorage,
  ) {}

  async build(disputeId: string): Promise<{ filename: string; data: Buffer }> {
    const dispute = await this.prisma.dispute.findUnique({
      where: { id: disputeId },
      include: { payment: { include: { refunds: true } } },
    });
    if (!dispute) throw new NotFoundException('Dispute not found');

    const booking = await this.prisma.booking.findUniqueOrThrow({
      where: { id: dispute.payment.bookingId },
      include: {
        customer: true,
        passengers: true,
        departure: { include: { tourRef: true } },
        payments: { include: { refunds: true }, orderBy: { createdAt: 'asc' } },
        documents: { include: { series: true }, orderBy: { createdAt: 'asc' } },
        waivers: { include: { passenger: true } },
        acceptances: { include: { legalDocument: true } },
        notifications: {
          where: { template: { in: ['booking_confirmed', 'booking_created'] } },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    const audit = await this.prisma.auditLog.findMany({
      where: {
        OR: [
          { entity: 'Booking', entityId: booking.id },
          {
            entity: 'Payment',
            entityId: { in: booking.payments.map((p) => p.id) },
          },
          { entity: 'Dispute', entityId: dispute.id },
        ],
      },
      orderBy: { createdAt: 'asc' },
      select: { action: true, entity: true, entityId: true, createdAt: true },
    });

    const entries: ZipEntry[] = [];
    const add = (name: string, data: Buffer) => entries.push({ name, data });
    const d = booking.departure;

    add(
      '01-confirmacion.json',
      json({
        reference: booking.reference,
        status: booking.status,
        createdAt: booking.createdAt,
        tourSlug: d.tourRef.slug,
        startsAt: d.startsAt,
        meetingPoint: d.meetingPoint,
        adults: booking.adults,
        children: booking.children,
        currency: booking.currency,
        totalCents: booking.totalCents,
        paidCents: booking.paidCents,
        refundedCents: booking.refundedCents,
        customer: {
          name: `${booking.customer.firstName} ${booking.customer.lastName}`,
          email: booking.customer.email,
          phone: booking.customer.phone,
          country: booking.customer.country,
        },
        passengers: booking.passengers.map((p) => ({
          name: `${p.firstName} ${p.lastName}`,
          idDocType: p.idDocType,
          idDocNumber: p.idDocNumber,
        })),
        priceSnapshot: booking.priceSnapshot,
        cancellationSnapshot: booking.cancellationSnapshot,
        emailsSent: booking.notifications
          .filter((n) => n.status === 'SENT')
          .map((n) => ({
            template: n.template,
            to: n.toAddress,
            sentAt: n.sentAt,
          })),
      }),
    );

    add(
      '02-pagos.json',
      json({
        dispute: {
          id: dispute.id,
          provider: dispute.provider,
          providerRef: dispute.providerRef,
          status: dispute.status,
          reason: dispute.reason,
          amountCents: dispute.amountCents,
          currency: dispute.currency,
          evidenceDueAt: dispute.evidenceDueAt,
          openedAt: dispute.createdAt,
          disputedPaymentId: dispute.paymentId,
        },
        payments: booking.payments.map((p) => ({
          id: p.id,
          provider: p.provider,
          providerRef: p.providerRef,
          method: p.method,
          kind: p.kind,
          status: p.status,
          currency: p.currency,
          amountCents: p.amountCents,
          refundedCents: p.refundedCents,
          paidAt: p.paidAt,
          refunds: p.refunds.map((r) => ({
            id: r.id,
            amountCents: r.amountCents,
            status: r.status,
            reason: r.reason,
            createdAt: r.createdAt,
          })),
        })),
      }),
    );

    const acceptances = booking.acceptances.map((a) => {
      const l = a.legalDocument;
      const file = `politicas/${l.kind.toLowerCase()}-${slug(l.locale)}-v${l.version}.md`;
      add(
        file,
        text(
          `# ${l.title}\n\n` +
            `- Tipo: ${l.kind}\n- Idioma: ${l.locale}\n- Versión: ${l.version}\n` +
            `- Publicado: ${l.publishedAt.toISOString()}\n- Huella SHA-256: ${l.contentHash}\n` +
            `- Aceptado: ${a.acceptedAt.toISOString()}\n- IP: ${a.ip ?? 'n/d'}\n` +
            `- Navegador: ${a.userAgent ?? 'n/d'}\n\n---\n\n${l.textSnapshot}\n`,
        ),
      );
      return {
        kind: l.kind,
        locale: l.locale,
        version: l.version,
        contentHash: l.contentHash,
        acceptedAt: a.acceptedAt,
        ip: a.ip,
        userAgent: a.userAgent,
        file,
      };
    });
    add('03-politicas-aceptadas.json', json(acceptances));

    add(
      '04-descargos.json',
      json({
        note: 'El texto del descargo no se guarda como snapshot: solo quién lo firmó, cuándo y desde qué IP.',
        waivers: booking.waivers.map((w) => ({
          status: w.status,
          version: w.version,
          passenger: w.passenger
            ? `${w.passenger.firstName} ${w.passenger.lastName}`
            : null,
          signerName: w.signerName,
          signerDocType: w.signerDocType,
          signerDocNumber: w.signerDocNumber,
          onBehalfOfMinor: w.onBehalfOfMinor,
          signedAt: w.signedAt,
          ip: w.ip,
        })),
      }),
    );

    add(
      '05-manifiesto.json',
      json({
        departure: {
          id: d.id,
          tourSlug: d.tourRef.slug,
          startsAt: d.startsAt,
          meetingPoint: d.meetingPoint,
          guideName: d.guideName,
          vehicleNote: d.vehicleNote,
        },
        passengers: booking.passengers.map((p) => {
          const waiver = booking.waivers.find(
            (w) => w.passengerId === p.id && w.status === 'SIGNED',
          );
          return {
            name: `${p.firstName} ${p.lastName}`,
            idDocType: p.idDocType,
            idDocNumber: p.idDocNumber,
            waiverStatus: waiver ? 'SIGNED' : 'PENDING',
            waiverSignedAt: waiver?.signedAt ?? null,
          };
        }),
        bookingStatus: booking.status,
      }),
    );

    add(
      '06-comprobantes.json',
      json(
        booking.documents.map((doc) => ({
          id: doc.id,
          docType: doc.docType,
          number: `${doc.series.prefix}-${String(doc.number).padStart(8, '0')}`,
          status: doc.status,
          currency: doc.currency,
          totalCents: doc.totalCents,
          issuedAt: doc.issuedAt,
          sunatCode: doc.sunatCode,
          hasPdf: doc.pdfKey !== null,
          hasXml: doc.xmlKey !== null,
        })),
      ),
    );
    // Los archivos del comprobante (PDF, XML y CDR) que ya están guardados.
    for (const doc of booking.documents) {
      const number = `${doc.series.prefix}-${String(doc.number).padStart(8, '0')}`;
      for (const [key, ext] of [
        [doc.pdfKey, 'pdf'],
        [doc.xmlKey, 'xml'],
        [doc.cdrKey, 'zip'],
      ] as const) {
        const data = key ? await this.storage.get(key) : null;
        if (data) add(`comprobantes/${number}.${ext}`, data);
      }
    }
    add('07-auditoria.json', json(audit));
    add(
      'LEEME.txt',
      text(
        `Paquete de evidencia de la disputa ${dispute.id}\n` +
          `Reserva ${booking.reference} - generado ${new Date().toISOString()}\n\n` +
          '01 confirmación de la reserva y correos enviados\n' +
          '02 pagos, reembolsos y datos de la disputa\n' +
          '03 políticas aceptadas (texto exacto en la carpeta politicas/)\n' +
          '04 descargos de responsabilidad firmados\n' +
          '05 manifiesto de la salida\n' +
          '06 comprobantes electrónicos (PDF en comprobantes/ si existen)\n' +
          '07 registro de auditoría de la reserva y sus pagos\n',
      ),
    );

    return {
      filename: `disputa-${slug(booking.reference)}-${dispute.id.slice(0, 8)}.zip`,
      data: buildZip(entries),
    };
  }
}
