import { cn } from '../../lib/cn';

interface SkeletonProps {
  className?: string;
}

/** 骨架占位块：使用 .skeleton 的 shimmer 动画，className 控制尺寸与形状。 */
export function Skeleton({ className }: SkeletonProps) {
  return <div className={cn('skeleton', className)} aria-hidden />;
}

interface SkeletonTextProps {
  lines?: number;
  className?: string;
}

/** 多行文本骨架，最后一行缩短以模拟自然排版。 */
export function SkeletonText({ lines = 3, className }: SkeletonTextProps) {
  return (
    <div className={cn('space-y-2', className)} aria-hidden>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} className={cn('h-3', i === lines - 1 ? 'w-2/3' : 'w-full')} />
      ))}
    </div>
  );
}
