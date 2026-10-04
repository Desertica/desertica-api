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
});
