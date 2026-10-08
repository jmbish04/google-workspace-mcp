import { useEffect, type RefObject } from "react"

/** Native scroll with the scrollbar hidden; the bottom edge fades only while
    content sits below it. The top edge belongs to the floating header's blur. */
export const SCROLL_REGION =
  "no-scrollbar scroll-fade-b min-h-0 flex-1 overflow-y-auto overscroll-contain scroll-pt-18 scroll-pb-10 [--scroll-fade-reveal:--spacing(8)] data-[fits=true]:scroll-fade-none data-[at-end=true]:scroll-fade-b-0"

/**
 * Writes data-fits and data-at-end straight onto the scroller. A stale scroll
 * timeline, or a browser with none, then never fades an empty bottom edge.
 */
export function useScrollEdges(
  scrollerRef: RefObject<HTMLElement | null>,
  contentRef?: RefObject<HTMLElement | null>
) {
  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) return
    const mark = () => {
      const max = scroller.scrollHeight - scroller.clientHeight
      scroller.dataset.fits = String(max <= 0)
      scroller.dataset.atEnd = String(max - scroller.scrollTop <= 1)
    }
    const observer = new ResizeObserver(mark)
    observer.observe(scroller)
    if (contentRef?.current) observer.observe(contentRef.current)
    scroller.addEventListener("scroll", mark, { passive: true })
    mark()
    return () => {
      observer.disconnect()
      scroller.removeEventListener("scroll", mark)
    }
  }, [scrollerRef, contentRef])
}