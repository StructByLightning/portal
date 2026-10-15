/**
 * Display-name collisions at persona creation.
 *
 * A persona posts under its display name, so a name that reads as someone
 * else's is impersonation: a persona minted as "antra" posts as antra. The
 * relay used to take any name enrollment asked for. Names are compared by
 * {@link nameKey}, which folds the ways two names can look alike without being
 * byte-equal — case, compatibility forms (full-width, ligatures), accents,
 * zero-width and other invisible characters, separators and punctuation, and
 * the common Cyrillic/Greek letters that pass for Latin ones.
 *
 * Checked only when a persona is CREATED (renames are operator hand-edits of
 * the identity file); see Relay.enroll for which names a creation must avoid.
 */

/** Cyrillic and Greek letters (lower-cased) that render like a Latin letter. */
const LOOKALIKES: Record<string, string> = {
  а: 'a', в: 'b', е: 'e', ё: 'e', з: '3', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't',
  у: 'y', х: 'x', і: 'i', ї: 'i', ј: 'j', ѕ: 's', ԁ: 'd', ԛ: 'q', ԝ: 'w', ӏ: 'l', ү: 'y', һ: 'h',
  α: 'a', β: 'b', ε: 'e', η: 'n', ι: 'i', κ: 'k', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x',
  ω: 'w', ɑ: 'a', ɡ: 'g', ı: 'i', ℓ: 'l',
};

/** The comparison key for a display name: equal keys = names that read alike.
 *  Empty when the name has no letters or digits at all. */
export function nameKey(name: string): string {
  const folded = name.normalize('NFKC').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
  let out = '';
  for (const ch of folded) out += LOOKALIKES[ch] ?? ch;
  return out.replace(/[^\p{L}\p{N}]/gu, '');
}
