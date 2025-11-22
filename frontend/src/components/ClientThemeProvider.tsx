"use client"
import { ConfigProvider, theme } from 'antd'

export function ClientThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <ConfigProvider theme={{ token: { colorPrimary: '#1e88e5', borderRadius: 8, fontSize: 14 }, algorithm: theme.defaultAlgorithm }}>
      {children}
    </ConfigProvider>
  )
}