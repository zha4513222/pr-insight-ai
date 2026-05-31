import type { Metadata } from 'next';
import './styles.css';

export const metadata: Metadata = {
  title: 'PR Insight AI',
  description: 'AI-assisted GitHub Pull Request review console'
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
