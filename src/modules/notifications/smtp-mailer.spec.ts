import { SMTPServer } from 'smtp-server';
import { SmtpMailer } from './smtp-mailer';

/** Servidor SMTP real en el loopback que guarda cada mensaje recibido. */
async function startServer(
  options: {
    auth?: { user: string; pass: string };
  } = {},
) {
  const received: { from: string; to: string[]; raw: string }[] = [];
  const authSeen: string[] = [];
  const server = new SMTPServer({
    disabledCommands: ['STARTTLS'],
    allowInsecureAuth: true,
    authOptional: !options.auth,
    onAuth(auth, _session, callback) {
      authSeen.push(`${auth.username}:${auth.password}`);
      if (
        options.auth &&
        auth.username === options.auth.user &&
        auth.password === options.auth.pass
      ) {
        callback(null, { user: auth.username });
      } else {
        callback(new Error('Invalid login'));
      }
    },
    onData(stream, session, callback) {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => {
        received.push({
          from: session.envelope.mailFrom
            ? session.envelope.mailFrom.address
            : '',
          to: session.envelope.rcptTo.map((r) => r.address),
          raw: Buffer.concat(chunks).toString('utf8'),
        });
        callback();
      });
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.server.address() as { port: number };
  return {
    port,
    received,
    authSeen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const base = {
  host: '127.0.0.1',
  secure: false,
  requireTls: false,
  from: 'Desértica <reservas@desertica.pe>',
};

describe('SmtpMailer (against a real SMTP server)', () => {
  it('sends a multipart message with the rendered subject, text and HTML', async () => {
    const smtp = await startServer();
    const mailer = new SmtpMailer({
      ...base,
      port: smtp.port,
      replyTo: 'hola@desertica.pe',
    });
    try {
      await mailer.send({
        to: 'ana@example.com',
        template: 'booking_confirmed',
        locale: 'en',
        data: {
          reference: 'DST-7K4Q9M',
          tourSlug: 'dune-buggy',
          startsAt: '2026-11-10T14:00:00.000Z',
          currency: 'USD',
          totalCents: 20000,
          paidCents: 20000,
        },
      });
    } finally {
      mailer.onModuleDestroy();
      await smtp.close();
    }
    expect(smtp.received).toHaveLength(1);
    const [mail] = smtp.received;
    expect(mail.from).toBe('reservas@desertica.pe');
    expect(mail.to).toEqual(['ana@example.com']);
    expect(mail.raw).toMatch(/^Subject: Booking confirmed DST-7K4Q9M$/m);
    expect(mail.raw).toMatch(/^To: ana@example.com$/m);
    expect(mail.raw).toMatch(/^Reply-To: hola@desertica.pe$/m);
    expect(mail.raw).toMatch(/^Auto-Submitted: auto-generated$/m);
    expect(mail.raw).toMatch(/Content-Type: multipart\/alternative/);
    expect(mail.raw).toMatch(/Content-Type: text\/plain/);
    expect(mail.raw).toMatch(/Content-Type: text\/html/);
  });

  it('lets a message override the default reply-to and authenticates when asked', async () => {
    const smtp = await startServer({ auth: { user: 'bot', pass: 's3cret' } });
    const mailer = new SmtpMailer({
      ...base,
      port: smtp.port,
      user: 'bot',
      password: 's3cret',
      replyTo: 'default@desertica.pe',
    });
    try {
      await mailer.send({
        to: 'staff@desertica.pe',
        template: 'contact_message',
        replyTo: 'cliente@example.com',
        data: { name: 'Marta', email: 'cliente@example.com', message: 'Hola' },
      });
    } finally {
      mailer.onModuleDestroy();
      await smtp.close();
    }
    expect(smtp.authSeen).toEqual(['bot:s3cret']);
    expect(smtp.received[0].raw).toMatch(/^Reply-To: cliente@example.com$/m);
  });

  it('rejects wrong credentials, and fails when TLS is required but not offered', async () => {
    const smtp = await startServer({ auth: { user: 'bot', pass: 's3cret' } });
    const message = {
      to: 'ana@example.com',
      template: 'booking_access',
      locale: 'es',
      data: { reference: 'DST-1', bookingUrl: 'https://desertica.pe/b' },
    };
    const wrong = new SmtpMailer({
      ...base,
      port: smtp.port,
      user: 'bot',
      password: 'nope',
    });
    const strict = new SmtpMailer({
      ...base,
      port: smtp.port,
      requireTls: true,
      user: 'bot',
      password: 's3cret',
    });
    try {
      await expect(wrong.send(message)).rejects.toThrow();
      await expect(strict.send(message)).rejects.toThrow();
      expect(smtp.received).toHaveLength(0);
    } finally {
      wrong.onModuleDestroy();
      strict.onModuleDestroy();
      await smtp.close();
    }
  });

  it('fails clearly for an unknown template without touching the network', async () => {
    const mailer = new SmtpMailer({ ...base, port: 1 });
    try {
      await expect(
        mailer.send({ to: 'a@b.co', template: 'nope', data: {} }),
      ).rejects.toThrow(/Unknown email template/);
    } finally {
      mailer.onModuleDestroy();
    }
  });
});
