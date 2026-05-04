/**
 * Detects double-encoded UTF-8 → Win-1251 → UTF-8 ("mojibake") patterns.
 *
 * When a client on Ukrainian Windows serialises Cyrillic text via a PowerShell
 * heredoc without an explicit UTF-8 codepage, the shell re-encodes UTF-8 bytes
 * as Win-1251 before curl/IRM sees them. The resulting bytes then get stored
 * and re-decoded as UTF-8, producing characteristic two-byte sequences like
 * "Р—" (was "З"), "вЂ" (was em-dash prefix), etc.
 *
 * Each MOJIBAKE_SIGNATURES entry corresponds to one well-known UTF-8 byte pair
 * that becomes visibly garbled when misinterpreted as Win-1251:
 *
 *   0xD0 0x97 → "Р" + "—"  (was Cyrillic "З", U+0417)
 *   0xD0 0x96 → "Р" + "–"  (was Cyrillic "Ж", U+0416)
 *   0xD0 0xA3 → "Р" + "Ј"  (was Cyrillic "У", U+0423)
 *   0xE2 0x80 → "в" + "Ђ"  (was em-dash first two bytes, U+2014 start)
 *   0xD1 0x83 → "С" + "ѓ"  (was Cyrillic "у", U+0443)
 */
const MOJIBAKE_SIGNATURES: RegExp[] = [
  /Р—/,
  /Р–/,
  /РЈ/,
  /вЂ/,
  /Сѓ/,
];

/**
 * Scans `text` for known mojibake bigrams.
 * Returns matched strings (empty array = clean input).
 */
export function detectMojibake(text: string): string[] {
  const hits: string[] = [];
  for (const pattern of MOJIBAKE_SIGNATURES) {
    const m = text.match(pattern);
    if (m) hits.push(m[0]);
  }
  return hits;
}
