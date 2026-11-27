import { BackgroundQueue } from '../../common/queue/background-queue';
import type { TourTitlesService } from '../cms/tour-titles.service';
import { NotificationsService } from './notifications.service';

function build(mailer: { send: jest.Mock }) {
  const notification = {
    create: jest.fn().mockResolvedValue({ id: 'n1' }),
    update: jest.fn().mockResolvedValue({}),
  };
  const queue = new BackgroundQueue();
  const service = new NotificationsService(
    { notification } as never,
    mailer,
    queue,
  );
  return { service, notification, queue };
}

describe('NotificationsService', () => {
  const message = { to: 'a@b.com', template: 'booking_created', data: {} };

  it('records a sent email', async () => {
    const { service, notification, queue } = build({
      send: jest.fn().mockResolvedValue(undefined),
    });
    await service.sendEmail(message, { bookingId: 'b1' });
    await queue.drain();
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

  it('records a failure without throwing, redacting addresses', async () => {
    const { service, notification, queue } = build({
      send: jest.fn().mockRejectedValue(new Error('smtp down for a@b.com')),
    });
    await expect(service.sendEmail(message)).resolves.toBeUndefined();
    await queue.drain();
    const data = (notification.update.mock.calls[0] as [{ data: object }])[0]
      .data as { status: string; error: string };
    expect(data.status).toBe('FAILED');
    expect(data.error).toContain('smtp down');
    expect(data.error).not.toContain('a@b.com');
  });

  it('returns before the email is sent', async () => {
    let release!: () => void;
    const send = jest.fn(
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    const { service, notification, queue } = build({ send });
    await service.sendEmail(message);
    expect(notification.create).toHaveBeenCalledTimes(1);
    expect(notification.update).not.toHaveBeenCalled();
    await new Promise((resolve) => setImmediate(resolve));
    expect(send).toHaveBeenCalledTimes(1);
    release();
    await queue.drain();
    expect(notification.update).toHaveBeenCalledTimes(1);
  });

  it('creates the row with the caller db but updates it with prisma', async () => {
    const { service, notification, queue } = build({
      send: jest.fn().mockResolvedValue(undefined),
    });
    const tx = {
      notification: {
        create: jest.fn().mockResolvedValue({ id: 'n2' }),
        update: jest.fn(),
      },
    };
    await service.sendEmail(message, {}, tx as never);
    await queue.drain();
    expect(tx.notification.create).toHaveBeenCalledTimes(1);
    expect(tx.notification.update).not.toHaveBeenCalled();
    expect(notification.create).not.toHaveBeenCalled();
    expect(notification.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'n2' } }),
    );
  });

  it('marks the row FAILED when the queue is full', async () => {
    const send = jest.fn();
    const { service, notification, queue } = build({ send });
    jest.spyOn(queue, 'enqueue').mockReturnValue(false);
    await service.sendEmail(message);
    expect(send).not.toHaveBeenCalled();
    expect(
      (notification.update.mock.calls[0] as [{ data: object }])[0].data,
    ).toMatchObject({ status: 'FAILED' });
  });

  describe('tour title', () => {
    function withTitles(titles: { forTours: jest.Mock }, tour: object | null) {
      const send = jest.fn().mockResolvedValue(undefined);
      const notification = {
        create: jest.fn().mockResolvedValue({ id: 'n1' }),
        update: jest.fn().mockResolvedValue({}),
      };
      const tourRef = { findUnique: jest.fn().mockResolvedValue(tour) };
      const queue = new BackgroundQueue();
      const service = new NotificationsService(
        { notification, tourRef } as never,
        { send },
        queue,
        titles as unknown as TourTitlesService,
      );
      return { service, send, tourRef, queue };
    }

    it('adds the title in the language of the email', async () => {
      const forTours = jest
        .fn()
        .mockResolvedValue(new Map([['dune-buggy', 'Buggy en las dunas']]));
      const { service, send, queue } = withTitles(
        { forTours },
        { slug: 'dune-buggy', title: 'Dune buggy' },
      );
      await service.sendEmail({
        to: 'a@b.com',
        template: 'booking_confirmed',
        locale: 'es-PE',
        data: { tourSlug: 'dune-buggy' },
      });
      await queue.drain();
      expect(forTours).toHaveBeenCalledWith(
        [{ slug: 'dune-buggy', title: 'Dune buggy' }],
        'es',
      );
      expect(
        (send.mock.calls[0] as [{ data: Record<string, unknown> }])[0].data,
      ).toEqual({ tourSlug: 'dune-buggy', tourTitle: 'Buggy en las dunas' });
    });

    it('still sends the email when the title cannot be resolved', async () => {
      const { service, send, queue } = withTitles(
        { forTours: jest.fn().mockRejectedValue(new Error('cms down')) },
        { slug: 'dune-buggy', title: 'Dune buggy' },
      );
      await service.sendEmail({
        to: 'a@b.com',
        template: 'booking_confirmed',
        data: { tourSlug: 'dune-buggy' },
      });
      await queue.drain();
      expect(send).toHaveBeenCalledTimes(1);
      expect(
        (send.mock.calls[0] as [{ data: Record<string, unknown> }])[0].data,
      ).toEqual({ tourSlug: 'dune-buggy' });
    });

    it('leaves emails without a tour untouched', async () => {
      const forTours = jest.fn();
      const { service, tourRef, queue } = withTitles({ forTours }, null);
      await service.sendEmail({
        to: 'a@b.com',
        template: 'booking_access',
        data: { reference: 'X' },
      });
      await queue.drain();
      expect(tourRef.findUnique).not.toHaveBeenCalled();
      expect(forTours).not.toHaveBeenCalled();
    });
  });
});
