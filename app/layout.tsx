import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';

import { MobileViewportController } from '@/components/mobile-viewport-controller';
import './globals.css';

const geistSans = Geist({
  preload: false,
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  preload: false,
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  icons: {
    icon: [
      { url: '/nito-16.png', sizes: '16x16', type: 'image/png' },
      { url: '/nito-32.png', sizes: '32x32', type: 'image/png' },
      { url: '/nito-48.png', sizes: '48x48', type: 'image/png' },
      { url: '/nito-64.png', sizes: '64x64', type: 'image/png' },
      { url: '/nito-128.png', sizes: '128x128', type: 'image/png' },
      { url: '/nito-256.png', sizes: '256x256', type: 'image/png' },
    ],
    shortcut: [{ url: '/nito-32.png', type: 'image/png' }],
    apple: [
      { url: '/nito-256.png', sizes: '256x256', type: 'image/png' },
    ],
  },
  title: 'NITO Web Wallet',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  minimumScale: 1,
  maximumScale: 5,
  userScalable: true,
  viewportFit: 'cover',
  themeColor: '#020712',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <MobileViewportController />
        {children}
      </body>
    </html>
  );
}
