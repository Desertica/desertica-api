import { Injectable, NotFoundException } from '@nestjs/common';
import { paginated, skipTake } from '../../common/pagination/pagination';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { ContactMessageQuery } from './dto/admin.dto';

const toDto = (m: Prisma.ContactMessageGetPayload<object>) => ({
  id: m.id,
  name: m.name,
  email: m.email,
  whatsapp: m.whatsapp,
  country: m.country,
  message: m.message,
  locale: m.locale,
  handled: m.handled,
  createdAt: m.createdAt,
});

/** Mensajes del formulario de contacto del sitio. */
@Injectable()
export class ContactMessagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(q: ContactMessageQuery) {
    const where: Prisma.ContactMessageWhereInput =
      q.handled === undefined ? {} : { handled: q.handled };
    const [rows, total] = await Promise.all([
      this.prisma.contactMessage.findMany({
        where,
        // Los pendientes primero; dentro de cada grupo, los más recientes.
        orderBy: [{ handled: 'asc' }, { createdAt: 'desc' }],
        ...skipTake(q),
      }),
      this.prisma.contactMessage.count({ where }),
    ]);
    return paginated(rows.map(toDto), q, total);
  }

  async setHandled(id: string, handled: boolean, actorId: string, ip?: string) {
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.contactMessage.findUnique({ where: { id } });
      if (!before) throw new NotFoundException('Message not found');
      const updated = await tx.contactMessage.update({
        where: { id },
        data: { handled },
      });
      if (before.handled !== handled) {
        await this.audit.record(
          {
            actorUserId: actorId,
            action: 'contactMessage.handled',
            entity: 'ContactMessage',
            entityId: id,
            before: { handled: before.handled },
            after: { handled },
            ip,
          },
          tx,
        );
      }
      return toDto(updated);
    });
  }
}
