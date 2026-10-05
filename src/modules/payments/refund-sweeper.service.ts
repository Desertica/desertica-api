import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnvVars } from '../../config/env.validation';
import { PrismaService } from '../../prisma/prisma.service';
import { RefundsExecutor } from './refunds.service';

const ADVISORY_KEY = 'desertica:refund-sweep';

/**
 * Ejecuta por la pasarela original los `Refund` en `PENDING` que dejan la
 * cancelación y la reprogramación (y los que no pudieron salir por una caída).
 * Los de pagos manuales no se ejecutan: el staff los confirma con
 * `completeRefund`. Un candado de aviso de Postgres evita que dos instancias
 * barran a la vez; además cada reembolso tiene su propio candado.
 */
@Injectable()
export class RefundSweeper
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(RefundSweeper.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly executor: RefundsExecutor,
    private readonly config: ConfigService<EnvVars, true>,
  ) {}

  onApplicationBootstrap(): void {
    const seconds = this.config.get('REFUND_SWEEP_SECONDS', { infer: true });
    if (seconds <= 0 || this.config.get('NODE_ENV', { infer: true }) === 'test')
      return;
    this.timer = setInterval(() => {
      this.runOnce().catch((error: unknown) =>
        this.logger.error(
          `Refund sweep failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }, seconds * 1000);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async runOnce(): Promise<{ executed: number }> {
    return this.prisma.$transaction(
      async (tx) => {
        const row = await tx.$queryRaw<{ locked: boolean }[]>`
          SELECT pg_try_advisory_xact_lock(hashtext(${ADVISORY_KEY})) AS locked`;
        if (!row[0]?.locked) return { executed: 0 };
        const pending = await this.prisma.refund.findMany({
          where: {
            status: 'PENDING',
            providerRef: null,
            payment: { provider: { in: ['STRIPE', 'CULQI'] } },
          },
          orderBy: { createdAt: 'asc' },
          select: { id: true },
          take: 50,
        });
        let executed = 0;
        for (const { id } of pending) {
          if ((await this.executor.execute(id)) === 'succeeded') executed++;
        }
        if (pending.length > 0) {
          this.logger.log(
            `Refund sweep: ${executed}/${pending.length} executed`,
          );
        }
        return { executed };
      },
      { timeout: 300_000, maxWait: 5_000 },
    );
  }
}
