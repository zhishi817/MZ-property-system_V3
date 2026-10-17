export function decideTestimonialSwipe(input: {
  deltaX: number
  deltaY: number
  velocityX: number
  viewportWidth: number
  horizontalLocked: boolean
}) {
  const distanceThreshold = Math.max(42, input.viewportWidth * 0.105)
  const quickFlick = Math.abs(input.deltaX) >= 14 && Math.abs(input.velocityX) >= 0.18
  const commit = input.horizontalLocked
    && Math.abs(input.deltaX) > Math.abs(input.deltaY) * 0.65
    && (Math.abs(input.deltaX) >= distanceThreshold || quickFlick)
  const direction = quickFlick
    ? input.velocityX < 0 ? 1 : -1
    : input.deltaX < 0 ? 1 : -1
  return { commit, direction, quickFlick, distanceThreshold }
}
