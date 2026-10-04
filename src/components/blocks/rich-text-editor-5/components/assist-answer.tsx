import type { Ref } from "react"
import { Badge } from "@/components/reui/badge"
import {
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@/components/reui/frame"

import { Button } from "@/components/ui/button"
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import type { AssistFinding } from "./assist-plans"
import { ASSIST_ACTIONS, PEOPLE, type AssistActionId } from "./data"
import { AssistTile, PersonAvatar } from "./value-faces"
import { XIcon, CircleHelpIcon } from "lucide-react"

export interface AssistAnswer {
  title: string
  findings: AssistFinding[]
  note?: string
  /** Tasks offered back when a typed ask matched none. */
  actions?: AssistActionId[]
}

interface AssistAnswerViewProps {
  answer: AssistAnswer
  onJump: (finding: AssistFinding) => void
  onRun: (id: AssistActionId) => void
  onClose: () => void
  closeRef?: Ref<HTMLButtonElement>
}

/** A read-only turn: findings that jump to their text, nothing edited. */
export function AssistAnswerView({
  answer,
  onJump,
  onRun,
  onClose,
  closeRef,
}: AssistAnswerViewProps) {
  const offered = ASSIST_ACTIONS.filter((action) =>
    answer.actions?.includes(action.id)
  )

  return (
    <>
      <FrameHeader className="flex-row items-center gap-2">
        <AssistTile />
        <FrameTitle className="min-w-0 flex-1 truncate">
          {answer.title}
        </FrameTitle>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                ref={closeRef}
                type="button"
                variant="outline"
                size="icon-xs"
                aria-label="Close answer"
                onClick={onClose}
              />
            }
          >
            <XIcon aria-hidden="true" />
          </TooltipTrigger>
          <TooltipContent>Close</TooltipContent>
        </Tooltip>
      </FrameHeader>

      <FramePanel className="flex flex-col gap-3">
        {answer.note ? (
          <p className="text-muted-foreground text-sm">{answer.note}</p>
        ) : null}

        {offered.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {offered.map((action) => (
              <Button
                key={action.id}
                type="button"
                variant="outline"
                size="sm"
                className="rounded-full"
                onClick={() => onRun(action.id)}
              >
                {action.icon}
                {action.label}
              </Button>
            ))}
          </div>
        ) : null}

        {answer.findings.length > 0 ? (
          <ul className="supports-[animation-timeline:scroll()]:scroll-fade-y flex max-h-52 min-h-0 flex-col gap-0.5 overflow-y-auto">
            {answer.findings.map((finding) => (
              <li key={finding.id}>
                <FindingRow finding={finding} onJump={onJump} />
              </li>
            ))}
          </ul>
        ) : null}
      </FramePanel>
    </>
  )
}

function FindingRow({
  finding,
  onJump,
}: {
  finding: AssistFinding
  onJump: (finding: AssistFinding) => void
}) {
  const person = PEOPLE.find((candidate) => candidate.id === finding.person)

  return (
    <Item
      size="xs"
      render={<button type="button" onClick={() => onJump(finding)} />}
      className="hover:bg-muted/60 cursor-pointer text-start"
    >
      <ItemMedia>
        {person ? (
          <PersonAvatar id={person.id} />
        ) : (
          <CircleHelpIcon aria-hidden="true" className="text-muted-foreground size-4" />
        )}
      </ItemMedia>
      <ItemContent className="min-w-0 gap-0">
        <ItemTitle className="w-full min-w-0 font-normal">
          <span className="truncate">
            {person ? person.name : finding.text}
          </span>
        </ItemTitle>
        <ItemDescription className="truncate text-xs">
          {person ? finding.text : finding.section}
        </ItemDescription>
      </ItemContent>
      {person ? (
        <Badge
          variant={finding.done ? "success-light" : "outline"}
          className="shrink-0"
        >
          {finding.done ? "Done" : "Open"}
        </Badge>
      ) : null}
    </Item>
  )
}