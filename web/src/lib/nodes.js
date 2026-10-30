// Friendly labels for x-ui node names. The master panel reports very short
// node names (G, F, FR, …), so the UI maps the known ones to a country name and
// falls back to the raw name for anything unknown. Country flags are kept in
// the map for optional use, but the label itself stays plain text because
// Windows renders emoji flags as two letter pairs (e.g. "DE آلمان").

const KNOWN = {
  G: { fa: 'آلمان', en: 'Germany', flag: '🇩🇪' },
  DE: { fa: 'آلمان', en: 'Germany', flag: '🇩🇪' },
  F: { fa: 'فنلاند', en: 'Finland', flag: '🇫🇮' },
  FI: { fa: 'فنلاند', en: 'Finland', flag: '🇫🇮' },
  FR: { fa: 'فرانسه', en: 'France', flag: '🇫🇷' },
  NL: { fa: 'هلند', en: 'Netherlands', flag: '🇳🇱' },
  US: { fa: 'آمریکا', en: 'United States', flag: '🇺🇸' },
  TR: { fa: 'ترکیه', en: 'Türkiye', flag: '🇹🇷' },
  GB: { fa: 'انگلیس', en: 'United Kingdom', flag: '🇬🇧' },
  EN: { fa: 'انگلیس', en: 'United Kingdom', flag: '🇬🇧' },
  UK: { fa: 'انگلیس', en: 'United Kingdom', flag: '🇬🇧' },
  CA: { fa: 'کانادا', en: 'Canada', flag: '🇨🇦' },
  RU: { fa: 'روسیه', en: 'Russia', flag: '🇷🇺' },
  AE: { fa: 'امارات', en: 'UAE', flag: '🇦🇪' },
  SW: { fa: 'سوئد', en: 'Sweden', flag: '🇸🇪' },
  SE: { fa: 'سوئد', en: 'Sweden', flag: '🇸🇪' },
};

export function nodeLabel(name, lang = 'fa') {
  const raw = String(name || '').trim();
  if (!raw || raw.toLowerCase() === 'local') {
    return lang === 'fa' ? 'نود محلی' : 'Local node';
  }
  const hit = KNOWN[raw.toUpperCase()];
  if (!hit) return raw;
  return lang === 'fa' ? hit.fa : hit.en;
}

// Short variant for tight spaces: flag only when the name is recognized.
export function nodeFlag(name) {
  const raw = String(name || '').trim();
  const hit = KNOWN[raw.toUpperCase()];
  return hit ? hit.flag : '';
}
