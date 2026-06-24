export const uiTokens = {
  spacing: {
    xs: 4,
    sm: 8,
    md: 12,
    lg: 16,
    xl: 20,
    xxl: 24,
    xxxl: 32,
  },
  radius: {
    sm: 8,
    md: 12,
    lg: 16,
    xl: 20,
    pill: 999,
  },
  font: {
    xs: 12,
    sm: 13,
    md: 14,
    lg: 16,
    xl: 18,
    xxl: 20,
    hero: 24,
  },
  breakpoints: {
    mobile: 768,
    tablet: 1024,
  },
  touchMinSize: 44,
  contentMaxWidth: 1440,
} as const

export function resolveResponsiveColumns(containerWidth: number) {
  if (containerWidth < 360) return 2
  if (containerWidth < uiTokens.breakpoints.mobile) return 3
  return 4
}
