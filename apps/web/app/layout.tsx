import "./globals.css";
import type { ReactNode } from "react";

export const metadata = {
  title: "Knowledge Worker UI",
  description: "Claude Agent SDK MVP"
};

const RootLayout = ({ children }: { children: ReactNode }) => {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
};

export default RootLayout;
