import { type ReactElement, type ReactNode } from "react";

interface MainLayoutProps {
  children: ReactNode;
}

export function MainLayout({ children }: MainLayoutProps): ReactElement {
  return (
    <div className="cofree-zen-layout">
      {/* 
        This is the new "Zen & Native" layout wrapper.
        We drop the heavy sidebars and focus on a clean, single-window experience. 
      */}
      <div className="cofree-zen-content">
        {children}
      </div>
    </div>
  );
}
