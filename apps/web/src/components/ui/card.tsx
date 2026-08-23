import * as React from "react";
import { cn } from "../../lib/utils";

/**
 * Card density comes ONLY from this `size` prop (design spec §1.4/§2.4) — routes pick a size and
 * never override CardContent padding ad hoc. The size flows to header/content/footer via context
 * so a call site sets it exactly once, on the Card.
 */
export type CardSize = "default" | "compact" | "flush";

const CardSizeContext = React.createContext<CardSize>("default");

const HEADER_PAD: Record<CardSize, string> = {
  default: "p-6",
  compact: "p-4",
  flush: "p-0"
};

const CONTENT_PAD: Record<CardSize, string> = {
  default: "p-6 pt-0",
  compact: "p-4 pt-0",
  flush: "p-0"
};

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  size?: CardSize;
}

export function Card({ className, size = "default", ...props }: CardProps) {
  return (
    <CardSizeContext.Provider value={size}>
      <div
        className={cn("rounded-lg border border-slate-200 bg-white shadow-sm", className)}
        {...props}
      />
    </CardSizeContext.Provider>
  );
}

export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  const size = React.useContext(CardSizeContext);
  return (
    <div className={cn("flex flex-col space-y-1.5", HEADER_PAD[size], className)} {...props} />
  );
}

export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  // Section-heading type (§1.3) — the only heading class permitted inside a card.
  return <h3 className={cn("text-sm font-semibold text-slate-900", className)} {...props} />;
}

export function CardDescription({
  className,
  ...props
}: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("text-sm text-slate-500", className)} {...props} />;
}

export function CardContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  const size = React.useContext(CardSizeContext);
  return <div className={cn(CONTENT_PAD[size], className)} {...props} />;
}

export function CardFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  const size = React.useContext(CardSizeContext);
  return <div className={cn("flex items-center", CONTENT_PAD[size], className)} {...props} />;
}
