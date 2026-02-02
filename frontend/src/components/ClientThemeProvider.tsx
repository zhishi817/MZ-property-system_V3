"use client"
import { ConfigProvider, theme, App as AntApp } from 'antd'

export function ClientThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <ConfigProvider theme={{ token: { colorPrimary: '#0052D9', colorBgLayout: '#F5F7FA', borderRadius: 8, fontSize: 14, lineHeight: 1.6 }, algorithm: theme.defaultAlgorithm }}>
      <AntApp>
        {children}
      </AntApp>
    </ConfigProvider>
  )
}
