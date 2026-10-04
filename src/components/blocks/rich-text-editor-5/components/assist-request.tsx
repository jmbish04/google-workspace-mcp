import { Dot } from "./value-faces"

/** What was asked and what it covered, echoed at the top of every turn. */
export interface AssistRequest {
  label: string
  scope: string
}

export function RequestLine({ request }: { request: AssistRequest }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="truncate">{request.label}</span>
      <Dot />
      <span className="text-muted-foreground shrink-0 text-xs font-normal">
        {request.scope}
      </span>
    </span>
  )
}