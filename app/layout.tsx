import type { Metadata } from 'next';
import { EpubProvider } from '@/context/EpubContext';
import './globals.css';

export const metadata: Metadata = {
  title: 'SmartBook Reader',
  description: 'Lisez vos ePubs avec des explications IA en vis-à-vis.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr">
      <body>
        <EpubProvider>{children}</EpubProvider>
      </body>
    </html>
  );
}
