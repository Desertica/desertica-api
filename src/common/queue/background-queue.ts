import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';

type Task = () => Promise<void>;

/**
 * Cola en memoria para trabajo que no debe retrasar la respuesta (p. ej. un
 * correo): `enqueue` vuelve de inmediato, así el tiempo de la petición no
 * depende de si hubo algo que enviar. Es de una sola instancia y no durable:
 * un reinicio pierde lo pendiente, por eso solo se usa para lo que el usuario
 * puede volver a pedir. Los errores se registran, nunca se propagan.
 */
@Injectable()
export class BackgroundQueue implements OnApplicationShutdown {
  static readonly CONCURRENCY = 4;
  /** Más allá de esto se descarta (con aviso) en vez de crecer sin límite. */
  static readonly MAX_PENDING = 1000;
  private static readonly DRAIN_ON_SHUTDOWN_MS = 10_000;

  private readonly logger = new Logger(BackgroundQueue.name);
  private readonly waiting: { name: string; task: Task }[] = [];
  private running = 0;
  private idle: (() => void)[] = [];

  /** Devuelve `false` si la cola está llena y la tarea se descartó. */
  enqueue(name: string, task: Task): boolean {
    if (this.waiting.length >= BackgroundQueue.MAX_PENDING) {
      this.logger.warn(`Queue full, dropping "${name}"`);
      return false;
    }
    this.waiting.push({ name, task });
    this.pump();
    return true;
  }

  private pump(): void {
    while (
      this.running < BackgroundQueue.CONCURRENCY &&
      this.waiting.length > 0
    ) {
      const { name, task } = this.waiting.shift()!;
      this.running++;
      // `setImmediate`: la tarea nunca corre dentro de la llamada a `enqueue`.
      setImmediate(() => {
        void task()
          .catch((error: unknown) => {
            this.logger.error(
              `Background task "${name}" failed: ${error instanceof Error ? error.name : 'error'}`,
            );
          })
          .finally(() => {
            this.running--;
            this.pump();
            if (this.running === 0 && this.waiting.length === 0) {
              for (const resolve of this.idle.splice(0)) resolve();
            }
          });
      });
    }
  }

  /** Espera a que no quede nada en curso ni pendiente (pruebas y apagado). */
  drain(): Promise<void> {
    if (this.running === 0 && this.waiting.length === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => this.idle.push(resolve));
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.race([
      this.drain(),
      new Promise<void>((resolve) =>
        setTimeout(resolve, BackgroundQueue.DRAIN_ON_SHUTDOWN_MS).unref(),
      ),
    ]);
  }
}
