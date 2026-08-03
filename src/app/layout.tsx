import type { Metadata } from "next";
import AIWorkerCleanup from "@/components/AIWorkerCleanup";
import "./globals.css";

export const metadata: Metadata = {
  title: "软著通 - 一键生成软著申报材料",
  description: "帮助开发者一键生成中国软件著作权登记所需的全套申报材料",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" className="h-full antialiased">
      <body className="min-h-full flex flex-col">
        {children}
        {/*
          The AI transport now runs server-side; the old /ai-worker.js Service
          Worker is removed. This component unregisters any lingering worker
          from prior versions so it stops intercepting /__ai_proxy__.
        */}
        <AIWorkerCleanup />
      </body>
    </html>
  );
}