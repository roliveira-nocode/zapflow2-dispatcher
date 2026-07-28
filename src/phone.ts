/**
 * Phone helpers shared by every dispatch route.
 *
 * Kept in its own module so both the campaign dispatcher and the SiteFlow
 * endpoint use exactly the same normalization rules.
 */

/** Valid Brazilian area codes are 11-99: never start with 0 or 1x below 11. */
const DDD = /^(1[1-9]|[2-9][0-9])$/;

/**
 * Normalize a Brazilian phone number to "+<digits>" E.164 form.
 *
 * - Strips every non-numeric character.
 * - If the number has 11 digits and no 55 country code, prefixes 55.
 * - Accepts only Brazilian numbers: starts with 55 and has 12 or 13 digits.
 * - Validates the Brazilian structure: a real area code, plus a 9-digit mobile
 *   starting with 9 or an 8-digit landline starting with 2-5.
 *
 * The structural check is not cosmetic. Without it the 55 prefix above is
 * applied blindly, so a foreign 11-digit number such as +1 415 555 0000 turns
 * into +5514155550000 — a perfectly plausible number in area code 14. The
 * request would be accepted and, on a real send, a WhatsApp message would
 * reach an unrelated person. Rejecting is the only safe outcome.
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

  const national = digits.slice(2);
  const areaCode = national.slice(0, 2);
  const subscriber = national.slice(2);

  if (!DDD.test(areaCode)) {
    return null;
  }
  // Every Brazilian mobile has 9 digits and starts with 9; landlines have 8
  // and start with 2-5.
  if (subscriber.length === 9 && !subscriber.startsWith("9")) {
    return null;
  }
  if (subscriber.length === 8 && !/^[2-5]/.test(subscriber)) {
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
