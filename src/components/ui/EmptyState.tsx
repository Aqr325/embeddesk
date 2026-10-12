import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

interface Props {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}

/** 统一空状态：图标 + 标题 + 描述 + 可选操作，用于列表/搜索无结果等场景。 */
export function EmptyState({ icon, title, description, action, className }: Props) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center gap-3 py-10 px-6 animate-fade-in',
        className,
      )}
    >
      {icon && (
        <div className="w-12 h-12 rounded-2xl bg-muted flex items-center justify-center text-muted-foreground">
          {icon}
        </div>
      )}
      <div>
        <p className="font-medium text-foreground">{title}</p>
        {description && <p className="text-sm text-muted-foreground mt-1">{description}</p>}
      </div>
      {action}
    </div>
  );
}
