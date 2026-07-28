/**
 * Phone helpers shared by every dispatch route.
 *
 * Kept in its own module so both the campaign dispatcher and the SiteFlow
 * endpoint use exactly the same normalization rules.
 */

/**
 * Normalize a Brazilian phone number to "+<digits>" E.164 form.
 *
 * - Strips every non-numeric character.
 * - If the number has 11 digits and no 55 country code, prefixes 55.
 * - Accepts only Brazilian numbers: starts with 55 and has 12 or 13 digits.
 *
 * Returns the normalized phone, or null if it is obviously invalid.
 */
export function normalizePhone(raw: string): string | null {
  let digits = raw.replace(/\D/g, "");

  if (!digits.startsWith("55") && digits.length === 11) {
    digits = `55${digits}`;
  }

  if (!digits.startsWith("55") || (digits.length !== 12 && digits.length !== 13)) {
    return null;
  }

  return `+${digits}`;
}

/**
 * Mask a phone number for logs and responses: keeps the country code, the DDD
 * and the last two digits, hiding everything in between.
 *
 * e.g. "+5511900000000" -> "+5511*******00"
 *
 * Use this anywhere a phone would otherwise be written to a log line.
 */
export function maskPhone(phone: string): string {
  // "+55" + DDD = 5 leading characters worth keeping.
  const HEAD = 5;
  const TAIL = 2;

  if (phone.length <= HEAD + TAIL) {
    return "*".repeat(phone.length);
  }

  const head = phone.slice(0, HEAD);
  const tail = phone.slice(-TAIL);
  return `${head}${"*".repeat(phone.length - HEAD - TAIL)}${tail}`;
}
