import { memo, useState } from "react"

import { Skeleton } from "@/components/ui/skeleton"

import { ORGANIZATIONS, PAGE_NAME } from "./data"
import { UserMenu } from "./user-menu"

/** Row shapes for the placeholder table: cell widths only, no copy. Long
    enough that the page scrolls under its sticky header. */
const ROWS = [
  ["w-40", "w-16", "w-12"],
  ["w-56", "w-20", "w-10"],
  ["w-32", "w-16", "w-14"],
  ["w-48", "w-12", "w-12"],
  ["w-44", "w-20", "w-10"],
  ["w-36", "w-16", "w-14"],
  ["w-52", "w-20", "w-12"],
  ["w-28", "w-12", "w-10"],
  ["w-44", "w-16", "w-14"],
  ["w-60", "w-20", "w-12"],
]

// customize: swap this whole body for your own page. The chat window reads
// nothing from here, so nothing else changes.
function BodySkeleton() {
  return (
    // The skeletons' pulse holds still for a reader who asked for no motion.
    <div
      aria-hidden="true"
      className="flex w-full flex-col gap-8 px-4 py-6 motion-reduce:**:data-[slot=skeleton]:animate-none sm:px-6"
    >
      <div className="flex flex-col gap-2">
        <Skeleton className="h-6 w-44" />
        <Skeleton className="h-3.5 w-64 max-w-full" />
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
      </div>

      <Skeleton className="h-56" />

      <div className="flex flex-col gap-3">
        <Skeleton className="h-3 w-28" />
        {ROWS.map((cells, index) => (
          <div key={index} className="flex items-center gap-4">
            {cells.map((width, cell) => (
              <Skeleton key={cell} className={`h-3.5 ${width}`} />
            ))}
            <Skeleton className="ms-auto h-6 w-14 shrink-0" />
          </div>
        ))}
      </div>
    </div>
  )
}

/** The page the chat sits over; only its header is real. Memoised, so no change
    in the chat ever re-renders it. */
export const PageBody = memo(function PageBody() {
  const [organizationId, setOrganizationId] = useState(ORGANIZATIONS[0].id)
  const organization =
    ORGANIZATIONS.find((entry) => entry.id === organizationId) ??
    ORGANIZATIONS[0]

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <header className="bg-background sticky top-0 z-10 flex h-14 items-center gap-2 border-b px-4 sm:px-6">
        <span className="min-w-0 truncate text-sm font-medium">
          {organization.name}
        </span>
        <span
          aria-hidden="true"
          className="bg-muted-foreground/40 size-1 shrink-0 rounded-full"
        />
        <span className="text-muted-foreground min-w-0 truncate text-sm">
          {PAGE_NAME}
        </span>
        <UserMenu
          organizationId={organizationId}
          onOrganizationChange={setOrganizationId}
          className="ms-auto"
        />
      </header>

      <BodySkeleton />
    </div>
  )
})