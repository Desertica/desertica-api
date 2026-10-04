const WEIGHTS = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
const PREFIXES = ['10', '15', '16', '17', '20'];

/** Formato: 11 dígitos que empiezan con un prefijo de contribuyente de SUNAT. */
export function hasRucFormat(ruc: string): boolean {
  return /^\d{11}$/.test(ruc) && PREFIXES.includes(ruc.slice(0, 2));
}

/** Dígito verificador de un RUC (módulo 11 sobre los diez primeros dígitos). */
export function hasValidRucCheckDigit(ruc: string): boolean {
  if (!hasRucFormat(ruc)) return false;
  const sum = WEIGHTS.reduce((acc, w, i) => acc + w * Number(ruc[i]), 0);
  const check = (11 - (sum % 11)) % 10;
  return check === Number(ruc[10]);
}
