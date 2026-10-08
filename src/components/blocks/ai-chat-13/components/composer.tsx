import {
  memo,
  useId,
  type FormEvent,
  type KeyboardEvent,
  type RefObject,
} from "react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Field, FieldLabel } from "@/components/ui/field"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group"
import { Kbd } from "@/components/ui/kbd"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { COMPOSER_PLACEHOLDER, SOURCES } from "./data"
import { PlusIcon, ArrowUpIcon } from "lucide-react"

/**
 * One box: the question, the way to send it, and a menu for what the assistant
 * may read. The draft lives with the caller, so hiding the window never loses it.
 */
export const Composer = memo(function Composer({
  value,
  onValueChange,
  sources,
  onSourcesChange,
  streaming,
  onSend,
  onStop,
  textareaRef,
}: {
  value: string
  onValueChange: (value: string) => void
  /** SOURCES ids attached to the next question. */
  sources: string[]
  onSourcesChange: (sources: string[]) => void
  /** True from the moment a question is sent until its answer settles. */
  streaming: boolean
  onSend: (text: string) => void
  onStop: () => void
  textareaRef?: RefObject<HTMLTextAreaElement | null>
}) {
  const inputId = useId()

  function send() {
    // While an answer is in flight the only primary action is Stop, so Enter
    // and the form must not slip a second question past it.
    if (streaming) return
    const trimmed = value.trim()
    // The send control never disables, so an empty press puts the caret back
    // in the box rather than doing nothing at all.
    if (!trimmed) {
      textareaRef?.current?.focus()
      return
    }
    onSend(trimmed)
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    send()
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends, Shift+Enter breaks the line. An IME candidate window also
    // fires Enter, and committing a word there must not post the message.
    if (
      event.key !== "Enter" ||
      event.shiftKey ||
      event.nativeEvent.isComposing
    )
      return
    event.preventDefault()
    send()
  }

  function toggleSource(id: string, attached: boolean) {
    // Kept in SOURCES order, so the ids a turn stores never depend on click order.
    onSourcesChange(
      SOURCES.map((source) => source.id).filter((sourceId) =>
        sourceId === id ? attached : sources.includes(sourceId)
      )
    )
  }

  return (
    <form onSubmit={submit}>
      <Field>
        <FieldLabel htmlFor={inputId} className="sr-only">
          Ask a question
        </FieldLabel>
        <InputGroup>
          <InputGroupTextarea
            id={inputId}
            ref={textareaRef}
            value={value}
            onChange={(event) => onValueChange(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={COMPOSER_PLACEHOLDER}
            // Starts two lines tall and grows with the text, capped so the
            // thread never loses the window.
            className="field-sizing-content max-h-32 min-h-14"
          />

          <InputGroupAddon align="block-end" className="justify-between">
            <DropdownMenu>
              {/* The span is load bearing: rendering the menu trigger as the
                  tooltip trigger merges away its keyboard open behaviour. */}
              <Tooltip>
                <TooltipTrigger render={<span className="flex" />}>
                  <DropdownMenuTrigger
                    render={
                      <InputGroupButton
                        size="icon-sm"
                        aria-label="Attach context"
                      />
                    }
                  >
                    <PlusIcon aria-hidden="true" />
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent>Attach context</TooltipContent>
              </Tooltip>
              <DropdownMenuContent align="start" side="top" className="w-60">
                {/* The label names the group, so each row reads with it. */}
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Read With This Question</DropdownMenuLabel>
                  {SOURCES.map((source) => (
                    <DropdownMenuCheckboxItem
                      key={source.id}
                      checked={sources.includes(source.id)}
                      onCheckedChange={(checked) =>
                        toggleSource(source.id, checked)
                      }
                      closeOnClick={false}
                    >
                      {source.icon}
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate text-sm">{source.chip}</span>
                        <span className="text-muted-foreground truncate text-xs">
                          {source.hint}
                        </span>
                      </span>
                    </DropdownMenuCheckboxItem>
                  ))}
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>

            {streaming ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={onStop}
              >
                Stop
              </Button>
            ) : (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="submit"
                      size="icon-sm"
                      aria-label="Send question"
                      className="rounded-full"
                    />
                  }
                >
                  <ArrowUpIcon aria-hidden="true" />
                </TooltipTrigger>
                <TooltipContent className="flex items-center gap-1.5">
                  Send
                  <Kbd>Enter</Kbd>
                </TooltipContent>
              </Tooltip>
            )}
          </InputGroupAddon>
        </InputGroup>
      </Field>
    </form>
  )
})