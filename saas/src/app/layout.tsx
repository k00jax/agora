import type { Metadata, Viewport } from 'next';
import './globals.css';

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0d0d1a',
};

export const metadata: Metadata = {
  title: 'Agora',
  description: 'Join a live roundtable discussion with five AI voices',
  manifest: '/manifest.json',
  icons: { icon: '/favicon.ico' },
  appleWebApp: { capable: true, title: 'Agora' },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head><link rel="manifest" href="/manifest.json" /></head>
      <body className="bg-[#0d0d1a] text-[#e8e8e8] antialiased min-h-screen">
        {children}
      </body>
    </html>
  );
}
