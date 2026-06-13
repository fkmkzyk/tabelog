import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Tabelog Draft Assistant | 食べログ下書きアシスタント',
  description: 'AIを活用して食べログの規約に適合した口コミ下書きを自動生成・管理する個人用Webアプリ',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
