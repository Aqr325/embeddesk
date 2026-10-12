import type { IntentId } from '../types';
import { INTENT_COLORS, INTENT_LABELS } from '../types';

interface Props {
  intent?: IntentId | string | null;
  size?: 'sm' | 'md';
}

export function IntentBadge({ intent, size = 'sm' }: Props) {
  if (!intent) return null;
  const color = INTENT_COLORS[intent] ?? '#888';
  const label = INTENT_LABELS[intent] ?? intent;
  const pad = size === 'md' ? 'px-3 py-1 text-sm' : 'px-2 py-0.5 text-xs';
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full font-medium ${pad}`}
      style={{ backgroundColor: color + '1a', color }}
    >
      <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: color }} />
      {label}
    </span>
  );
}
