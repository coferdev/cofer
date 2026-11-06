import React from "react";
import { ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";
interface InteractiveHoverButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> { text?: string; }
const InteractiveHoverButton = React.forwardRef<HTMLButtonElement, InteractiveHoverButtonProps>(({ text = "Button", className, ...props }, ref) => (
  <button ref={ref} className={cn("group relative w-32 cursor-pointer overflow-hidden rounded-full border bg-background p-2 text-center font-semibold", className)} {...props}>
    <span className="inline-block translate-x-1 transition-all duration-300 group-hover:translate-x-12 group-hover:opacity-0">{text}</span>
    <div className="absolute top-0 z-10 flex h-full w-full translate-x-12 items-center justify-center gap-2 text-primary-foreground opacity-0 transition-all duration-300 group-hover:-translate-x-1 group-hover:opacity-100"><span>{text}</span><ArrowRight /></div>
    <div className="absolute left-[20%] top-[40%] h-2 w-2 scale-[1] rounded-lg bg-primary transition-all duration-300 group-hover:left-[0%] group-hover:top-[0%] group-hover:h-full group-hover:w-full group-hover:scale-[1.8] group-hover:bg-primary"></div>
  </button>
));
InteractiveHoverButton.displayName = "InteractiveHoverButton";

// Navigation needs a real link so it works with keyboard shortcuts, open-in-new-tab,
// and even if the click handler is unavailable.
function InteractiveHoverLink({ text = "Button", className, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { text?: string }) {
  return (
    <a className={cn("group relative w-32 cursor-pointer overflow-hidden rounded-full border bg-background p-2 text-center font-semibold", className)} {...props}>
      <span className="inline-block translate-x-1 transition-all duration-300 group-hover:translate-x-12 group-hover:opacity-0">{text}</span>
      <div aria-hidden="true" className="absolute top-0 z-10 flex h-full w-full translate-x-12 items-center justify-center gap-2 text-primary-foreground opacity-0 transition-all duration-300 group-hover:-translate-x-1 group-hover:opacity-100"><span>{text}</span><ArrowRight /></div>
      <div aria-hidden="true" className="absolute left-[20%] top-[40%] h-2 w-2 scale-[1] rounded-lg bg-primary transition-all duration-300 group-hover:left-[0%] group-hover:top-[0%] group-hover:h-full group-hover:w-full group-hover:scale-[1.8] group-hover:bg-primary"></div>
    </a>
  );
}
export { InteractiveHoverButton, InteractiveHoverLink };
