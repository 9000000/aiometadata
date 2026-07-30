import { cn } from "@/lib/utils"

function Skeleton({
  className,
  variant = "pulse",
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { variant?: "pulse" | "shimmer" }) {
  return (
    <div
      className={cn(
        "rounded-md bg-muted",
        variant === "shimmer" ? "animate-shimmer" : "animate-pulse",
        className
      )}
      {...props}
    />
  )
}

export { Skeleton }
