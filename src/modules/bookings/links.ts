/**
 * Enlaces que se mandan por correo. Las rutas las define `desertica-web`;
 * si cambian allá, se ajustan solo aquí.
 */
export const links = {
  booking: (base: string, reference: string, token: string) =>
    `${base}/booking/${encodeURIComponent(reference)}?token=${encodeURIComponent(token)}`,
  waiver: (base: string, token: string) =>
    `${base}/waiver/${encodeURIComponent(token)}`,
  payment: (base: string, token: string) =>
    `${base}/pay/${encodeURIComponent(token)}`,
};
