import { BackgroundQueue } from './background-queue';

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('BackgroundQueue', () => {
  it('returns before the task runs and runs it afterwards', async () => {
    const queue = new BackgroundQueue();
    const ran = jest.fn();
    expect(queue.enqueue('a', () => Promise.resolve(void ran()))).toBe(true);
    expect(ran).not.toHaveBeenCalled();
    await queue.drain();
    expect(ran).toHaveBeenCalledTimes(1);
  });

  it('logs a failing task without throwing and keeps going', async () => {
    const queue = new BackgroundQueue();
    const after = jest.fn();
    queue.enqueue('boom', () =>
      Promise.reject(new Error('secret@example.com')),
    );
    queue.enqueue('ok', () => Promise.resolve(void after()));
    await expect(queue.drain()).resolves.toBeUndefined();
    expect(after).toHaveBeenCalled();
  });

  it('runs at most CONCURRENCY tasks at once', async () => {
    const queue = new BackgroundQueue();
    let active = 0;
    let peak = 0;
    const releases: (() => void)[] = [];
    for (let i = 0; i < 10; i++) {
      queue.enqueue(`t${i}`, async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active--;
      });
    }
    await tick();
    await tick();
    expect(active).toBe(BackgroundQueue.CONCURRENCY);
    let finished = false;
    void queue.drain().then(() => (finished = true));
    while (!finished) {
      releases.splice(0).forEach((release) => release());
      await tick();
    }
    expect(peak).toBe(BackgroundQueue.CONCURRENCY);
  });

  it('drops tasks beyond the pending limit instead of growing forever', async () => {
    const queue = new BackgroundQueue();
    const block = new Promise<void>(() => undefined);
    for (let i = 0; i < BackgroundQueue.CONCURRENCY; i++) {
      queue.enqueue('blocker', () => block);
    }
    await tick();
    for (let i = 0; i < BackgroundQueue.MAX_PENDING; i++) {
      expect(queue.enqueue('fill', () => Promise.resolve())).toBe(true);
    }
    expect(queue.enqueue('overflow', () => Promise.resolve())).toBe(false);
  });
});
