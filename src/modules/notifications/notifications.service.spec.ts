import type { TourTitlesService } from '../cms/tour-titles.service';
import { NotificationsService } from './notifications.service';

function build(mailer: { send: jest.Mock }) {
  const notification = {
    create: jest.fn().mockResolvedValue({ id: 'n1' }),
    update: jest.fn().mockResolvedValue({}),
  };
  const service = new NotificationsService({ notification } as never, mailer);
  return { service, notification };
}

describe('NotificationsService', () => {
  const message = { to: 'a@b.com', template: 'booking_created', data: {} };

  it('records a sent email', async () => {
    const { service, notification } = build({
      send: jest.fn().mockResolvedValue(undefined),
    });
    await service.sendEmail(message, { bookingId: 'b1' });
    expect(notification.create).toHaveBeenCalledWith({
      data: {
        bookingId: 'b1',
        channel: 'EMAIL',
        template: 'booking_created',
        toAddress: 'a@b.com',
      },
    });
    expect(
      (notification.update.mock.calls[0] as [{ data: { status: string } }])[0]
        .data.status,
    ).toBe('SENT');
  });

  it('records a failure without throwing', async () => {
    const { service, notification } = build({
      send: jest.fn().mockRejectedValue(new Error('smtp down')),
    });
    await expect(service.sendEmail(message)).resolves.toBeUndefined();
    expect(
      (notification.update.mock.calls[0] as [{ data: object }])[0].data,
    ).toMatchObject({
      status: 'FAILED',
      error: 'smtp down',
    });
  });

  describe('tour title', () => {
    function withTitles(titles: { forTours: jest.Mock }, tour: object | null) {
      const send = jest.fn().mockResolvedValue(undefined);
      const notification = {
        create: jest.fn().mockResolvedValue({ id: 'n1' }),
        update: jest.fn().mockResolvedValue({}),
      };
      const tourRef = { findUnique: jest.fn().mockResolvedValue(tour) };
      const service = new NotificationsService(
        { notification, tourRef } as never,
        { send },
        titles as unknown as TourTitlesService,
      );
      return { service, send, tourRef };
    }

    it('adds the title in the language of the email', async () => {
      const forTours = jest
        .fn()
        .mockResolvedValue(new Map([['dune-buggy', 'Buggy en las dunas']]));
      const { service, send } = withTitles(
        { forTours },
        { slug: 'dune-buggy', title: 'Dune buggy' },
      );
      await service.sendEmail({
        to: 'a@b.com',
        template: 'booking_confirmed',
        locale: 'es-PE',
        data: { tourSlug: 'dune-buggy' },
      });
      expect(forTours).toHaveBeenCalledWith(
        [{ slug: 'dune-buggy', title: 'Dune buggy' }],
        'es',
      );
      expect(
        (send.mock.calls[0] as [{ data: Record<string, unknown> }])[0].data,
      ).toEqual({ tourSlug: 'dune-buggy', tourTitle: 'Buggy en las dunas' });
    });

    it('still sends the email when the title cannot be resolved', async () => {
      const { service, send } = withTitles(
        { forTours: jest.fn().mockRejectedValue(new Error('cms down')) },
        { slug: 'dune-buggy', title: 'Dune buggy' },
      );
      await service.sendEmail({
        to: 'a@b.com',
        template: 'booking_confirmed',
        data: { tourSlug: 'dune-buggy' },
      });
      expect(send).toHaveBeenCalledTimes(1);
      expect(
        (send.mock.calls[0] as [{ data: Record<string, unknown> }])[0].data,
      ).toEqual({ tourSlug: 'dune-buggy' });
    });

    it('leaves emails without a tour untouched', async () => {
      const forTours = jest.fn();
      const { service, tourRef } = withTitles({ forTours }, null);
      await service.sendEmail({
        to: 'a@b.com',
        template: 'booking_access',
        data: { reference: 'X' },
      });
      expect(tourRef.findUnique).not.toHaveBeenCalled();
      expect(forTours).not.toHaveBeenCalled();
    });
  });
});
