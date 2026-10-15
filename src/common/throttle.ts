/**
 * Límite de peticiones por IP para un endpoint concreto (se suma al global).
 * `THROTTLE_SCALE` multiplica el límite: las pruebas e2e lo suben para no
 * toparse con los límites de producción; en producción no se define.
 */
export const rateLimit = (limit: number, ttlMs: number) => ({
  default: {
    limit: () =>
      Math.max(1, Math.round(limit * Number(process.env.THROTTLE_SCALE ?? 1))),
    ttl: ttlMs,
  },
});
