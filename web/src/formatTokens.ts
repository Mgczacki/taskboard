const exact = new Intl.NumberFormat();
const short = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

const units = [
  { size: 1_000, name: 'thousand' },
  { size: 1_000_000, name: 'million' },
  { size: 1_000_000_000, name: 'billion' },
];

export function formatTokens(tokens: number): string {
  if (tokens < 1_000) return exact.format(tokens);
  let index = 0;
  while (index < units.length - 1 && tokens >= units[index + 1].size) index++;
  if (index < units.length - 1 && Math.round(tokens / units[index].size * 10) >= 10_000) index++;
  const unit = units[index];
  return `${short.format(tokens / unit.size)} ${unit.name}`;
}
