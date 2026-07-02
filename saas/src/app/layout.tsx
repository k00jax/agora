import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'AI Group Chat',
  description: 'Join a roundtable discussion with five AI models',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-[#0d0d1a] text-[#e8e8e8] antialiased min-h-screen">
        {children}
      </body>
    </html>
  );
}
