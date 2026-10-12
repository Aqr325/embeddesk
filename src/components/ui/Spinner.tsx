import { Loader2 } from 'lucide-react';
import { cn } from '../../lib/cn';

interface Props {
  size?: number;
  className?: string;
}

/** 统一加载指示：旋转图标，默认 accent 色，可由 className 覆盖尺寸与颜色。 */
export function Spinner({ size = 16, className }: Props) {
  return <Loader2 size={size} className={cn('animate-spin text-accent', className)} aria-hidden />;
}
