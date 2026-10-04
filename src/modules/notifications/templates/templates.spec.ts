import { langOf } from './format';
import { escapeHtml, safeUrl } from './layout';
import { renderEmail, TEMPLATE_NAMES, UnknownTemplateError } from './index';

const bookingData = {
  reference: 'DST-7K4Q9M',
  tourSlug: 'dune-buggy',
  tourTitle: 'Dune Buggy & Sandboard',
  startsAt: '2026-11-10T14:00:00.000Z',
  currency: 'USD',
  totalCents: 20000,
  paidCents: 6000,
  pendingCents: 14000,
};

/** Datos representativos de cada plantilla (los que arman los servicios). */
const SAMPLES: Record<string, Record<string, unknown>> = {
  booking_created: {
    ...bookingData,
    bookingUrl: 'https://desertica.pe/booking/DST-7K4Q9M?token=abc_DEF-123',
    waiverUrls: [
      'https://desertica.pe/waiver/tok1',
      'https://desertica.pe/waiver/tok2',
    ],
  },
  booking_confirmed: bookingData,
  booking_cancelled: {
    ...bookingData,
    refundDueCents: 10000,
    reason: 'Mar picado',
  },
  booking_rescheduled: {
    ...bookingData,
    adjustment: { type: 'CHARGE', amountCents: 1500 },
  },
  booking_expired: bookingData,
  booking_access: {
    reference: 'DST-7K4Q9M',
    bookingUrl: 'https://desertica.pe/booking/DST-7K4Q9M?token=abc',
  },
  payment_link: {
    ...bookingData,
    kind: 'BALANCE',
    amountCents: 14000,
    expiresAt: '2026-11-12T14:00:00.000Z',
    paymentUrl: 'https://desertica.pe/pay/tok',
  },
  departure_cancelled: { ...bookingData, reason: 'Sin guía disponible' },
  complaint_received: {
    correlative: 42,
    kind: 'RECLAMO',
    consumerName: 'Rosa Huamán',
    description: 'Tour dune buggy',
    detail: 'Llegó tarde.\nEl recorrido fue corto.',
    request: 'Devolución parcial',
    createdAt: '2026-10-04T15:00:00.000Z',
    dueAt: '2026-10-25T15:00:00.000Z',
  },
  complaint_answered: {
    correlative: 42,
    consumerName: 'Rosa Huamán',
    answer: 'Lamentamos lo ocurrido.\nTe devolvimos el 30 %.',
    answeredAt: '2026-10-10T15:00:00.000Z',
  },
  complaint_staff_alert: { correlative: 42, dueAt: '2026-10-25T15:00:00.000Z' },
  contact_message: {
    id: 'x',
    name: 'Marta',
    email: 'marta@example.com',
    whatsapp: '+51999',
    country: 'PE',
    message: '¿Hay cupo en diciembre?',
  },
};

describe('email templates', () => {
  it('has a sample for every template (so a new one cannot skip these tests)', () => {
    expect([...TEMPLATE_NAMES].sort()).toEqual(Object.keys(SAMPLES).sort());
  });

  describe.each(TEMPLATE_NAMES)('%s', (template) => {
    it.each(['es', 'en', 'es-PE', 'en-US', 'fr'])(
      'renders subject, text and HTML for locale %s',
      (locale) => {
        const mail = renderEmail(template, locale, SAMPLES[template]);
        expect(mail.subject.length).toBeGreaterThan(5);
        expect(mail.subject).not.toMatch(/[\r\n]/);
        for (const part of [mail.subject, mail.text, mail.html]) {
          expect(part).not.toMatch(/undefined|NaN|\[object|null/);
        }
        expect(mail.html).toMatch(/^<!doctype html>/);
        expect(mail.text.trim().length).toBeGreaterThan(40);
      },
    );

    it('is deterministic', () => {
      expect(renderEmail(template, 'es', SAMPLES[template])).toEqual(
        renderEmail(template, 'es', SAMPLES[template]),
      );
    });
  });

  it('writes customer emails in Spanish for es* and in English otherwise', () => {
    const es = renderEmail('booking_confirmed', 'es-PE', bookingData);
    const en = renderEmail('booking_confirmed', 'en', bookingData);
    const other = renderEmail('booking_confirmed', 'fr-FR', bookingData);
    expect(es.subject).toBe('Reserva confirmada DST-7K4Q9M');
    expect(es.html).toContain('<html lang="es">');
    expect(en.subject).toBe('Booking confirmed DST-7K4Q9M');
    expect(en.html).toContain('<html lang="en">');
    expect(other.subject).toBe(en.subject);
  });

  it('formats money and dates for the language, in Lima time', () => {
    const es = renderEmail('booking_confirmed', 'es', bookingData);
    const en = renderEmail('booking_confirmed', 'en', bookingData);
    expect(es.text).toContain('Total: USD');
    expect(es.text).toContain('200.00');
    expect(es.text).toContain('hora de Lima');
    // 14:00Z son las 09:00 en Lima.
    expect(es.text).toMatch(/9:00/);
    expect(en.text).toContain('Total: $200.00');
    expect(en.text).toContain('Lima time');
    const pen = renderEmail('booking_confirmed', 'en', {
      ...bookingData,
      currency: 'PEN',
    });
    expect(pen.text).toContain('PEN');
  });

  it('falls back to the slug when there is no title, and shows both languages of a refund', () => {
    const { tourTitle: _title, ...withoutTitle } = bookingData;
    void _title;
    expect(renderEmail('booking_confirmed', 'en', withoutTitle).text).toContain(
      'Tour: dune-buggy',
    );
    const withRefund = renderEmail('booking_cancelled', 'es', {
      ...bookingData,
      refundDueCents: 10000,
    });
    expect(withRefund.text).toContain('reembolso de USD');
    const none = renderEmail('booking_cancelled', 'en', {
      ...bookingData,
      refundDueCents: 0,
    });
    expect(none.text).toContain('does not generate a refund');
  });

  it('explains a price adjustment when rescheduling', () => {
    const charge = renderEmail('booking_rescheduled', 'en', {
      ...bookingData,
      adjustment: { type: 'CHARGE', amountCents: 1500 },
    });
    expect(charge.text).toContain('$15.00 more');
    const refund = renderEmail('booking_rescheduled', 'es', {
      ...bookingData,
      adjustment: { type: 'REFUND', amountCents: 1500 },
    });
    expect(refund.text.replace(/\u00a0/g, ' ')).toContain('USD 15.00');
    expect(refund.text).toContain('menos');
    const same = renderEmail('booking_rescheduled', 'en', {
      ...bookingData,
      adjustment: null,
    });
    expect(same.text).toContain('does not change');
  });

  it('puts links in both parts and numbers the waiver links', () => {
    const mail = renderEmail('booking_created', 'en', SAMPLES.booking_created);
    expect(mail.text).toContain(
      'https://desertica.pe/booking/DST-7K4Q9M?token=abc_DEF-123',
    );
    expect(mail.html).toContain(
      'href="https://desertica.pe/booking/DST-7K4Q9M?token=abc_DEF-123"',
    );
    expect(mail.text).toContain(
      'Passenger 2: https://desertica.pe/waiver/tok2',
    );
    const paid = renderEmail('booking_created', 'en', {
      ...bookingData,
      pendingCents: 0,
      bookingUrl: 'https://desertica.pe/b',
    });
    expect(paid.text).not.toContain('Balance due');
  });

  it('escapes everything that comes from a person', () => {
    const evil = '<script>alert("x")</script> & "q" \'s\'';
    const mail = renderEmail('complaint_answered', 'es', {
      ...SAMPLES.complaint_answered,
      consumerName: evil,
      answer: `${evil}\nsegunda línea`,
    });
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('&lt;script&gt;');
    expect(mail.html).toContain('&amp;');
    expect(mail.html).toContain('<br>');
    // El texto plano no es HTML: va tal cual.
    expect(mail.text).toContain('<script>');

    const contact = renderEmail('contact_message', 'es', {
      ...SAMPLES.contact_message,
      name: 'Eve\r\nBcc: x@evil.test',
      message: '<img src=x onerror=alert(1)>',
    });
    expect(contact.subject).not.toMatch(/[\r\n]/);
    expect(contact.html).not.toContain('<img');
  });

  it('refuses links that are not http(s)', () => {
    expect(() =>
      renderEmail('booking_access', 'en', {
        reference: 'X',
        bookingUrl: 'javascript:alert(1)',
      }),
    ).toThrow();
    expect(() => safeUrl('not a url')).toThrow();
    expect(safeUrl('https://a.test/x?y=1&z=2')).toBe(
      'https://a.test/x?y=1&z=2',
    );
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });

  it('writes internal notices in Spanish whatever the locale, and the complaints book in Spanish by default', () => {
    expect(
      renderEmail('contact_message', 'en', SAMPLES.contact_message).html,
    ).toContain('<html lang="es">');
    expect(
      renderEmail('complaint_staff_alert', 'en', SAMPLES.complaint_staff_alert)
        .subject,
    ).toBe('Nuevo reclamo N.º 000042');
    const received = renderEmail(
      'complaint_received',
      undefined,
      SAMPLES.complaint_received,
    );
    expect(received.subject).toBe('Hoja de reclamación N.º 000042');
    expect(received.text).toContain('Reclamo');
    expect(received.text).toContain('INDECOPI');
  });

  it('throws for an unknown template', () => {
    expect(() => renderEmail('nope', 'es', {})).toThrow(UnknownTemplateError);
  });

  it('keeps langOf simple', () => {
    expect(langOf('es-PE')).toBe('es');
    expect(langOf('ES')).toBe('es');
    expect(langOf('en')).toBe('en');
    expect(langOf('qx-AB')).toBe('en');
    expect(langOf(undefined)).toBe('en');
  });
});
