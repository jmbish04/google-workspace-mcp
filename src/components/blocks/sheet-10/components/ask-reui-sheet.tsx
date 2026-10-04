import { useEffect, useRef, useState, type FormEvent } from "react"
import { cn } from "cn"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Field, FieldLabel } from "@/components/ui/field"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { BotIcon, SparklesIcon, SquarePenIcon, RefreshCwIcon, MoreHorizontalIcon, FileTextIcon, ListChecksIcon, Trash2Icon, XIcon, PlusIcon, ImageIcon, GlobeIcon, MicIcon, ArrowUpIcon } from "lucide-react"

interface ChatMessageRecord {
  id: string
  role: "assistant" | "user"
  content: string
  timestamp: string
}

interface PromptSuggestionRecord {
  id: string
  label: string
  prompt: string
}

const mutedIconButtonClassName = "text-muted-foreground hover:text-foreground"

const INITIAL_MESSAGES: ChatMessageRecord[] = [
  {
    id: "demo-user-1",
    role: "user",
    timestamp: "4 hours ago",
    content: "Can you review sheet-10 before handoff?",
  },
  {
    id: "demo-assistant-1",
    role: "assistant",
    timestamp: "4 hours ago",
    content:
      "Yes. I would check the sheet shell first: header density, body scroll ownership, and whether the composer stays pinned without adding a footer divider.",
  },
  {
    id: "demo-user-2",
    role: "user",
    timestamp: "4 hours ago",
    content: "What should be fixed first?",
  },
  {
    id: "demo-assistant-2",
    role: "assistant",
    timestamp: "4 hours ago",
    content:
      "Start with the footer. Keep the question entry form compact, remove extra footer actions, then confirm the chat still has enough context to feel useful.",
  },
]

const PROMPT_SUGGESTIONS: PromptSuggestionRecord[] = [
  {
    id: "issues",
    label: "Find ReUI issues related to sheets",
    prompt: "Find ReUI issues related to sheet previews and scroll behavior.",
  },
  {
    id: "work",
    label: "What should I work on?",
    prompt: "What should I work on next in the ReUI block library?",
  },
  {
    id: "overdue",
    label: "Show overdue review tasks",
    prompt: "Show overdue ReUI review tasks and group them by priority.",
  },
  {
    id: "active",
    label: "What block areas are active?",
    prompt: "What ReUI block areas are active right now?",
  },
]

function createAssistantReply(
  prompt: string,
  messageIndex: number
): ChatMessageRecord {
  const normalizedPrompt = prompt.toLowerCase()

  if (normalizedPrompt.includes("overdue")) {
    return {
      id: `assistant-${messageIndex}`,
      role: "assistant",
      timestamp: "Now",
      content:
        "Start with the items that can break previews: scroll containment, pinned footer spacing, and mobile width. Then batch copy and icon review in one pass.",
    }
  }

  if (normalizedPrompt.includes("sheet")) {
    return {
      id: `assistant-${messageIndex}`,
      role: "assistant",
      timestamp: "Now",
      content:
        "For sheet work, verify the fixed header and footer chain, confirm the body owns scrolling through min-h-0, then test the composer at mobile width.",
    }
  }

  if (normalizedPrompt.includes("work")) {
    return {
      id: `assistant-${messageIndex}`,
      role: "assistant",
      timestamp: "Now",
      content:
        "A strong next pass is to check long prompts, empty state, and mobile overflow, then capture one preview screenshot before handoff.",
    }
  }

  if (
    normalizedPrompt.includes("active") ||
    normalizedPrompt.includes("area")
  ) {
    return {
      id: `assistant-${messageIndex}`,
      role: "assistant",
      timestamp: "Now",
      content:
        "Active areas: application sheets, dialog polish, and data-grid review queues. Sheet work is closest to release once footer spacing and mobile checks are clean.",
    }
  }

  return {
    id: `assistant-${messageIndex}`,
    role: "assistant",
    timestamp: "Now",
    content: `I can turn"${prompt}" into a scoped ReUI task: identify the affected block, propose the smallest change, and list the preview checks before release.`,
  }
}

function MessageBubble({ message }: { message: ChatMessageRecord }) {
  const isUser = message.role === "user"

  return (
    <article
      className={cn(
        "flex min-w-0",
        isUser ? "justify-end" : "items-start gap-2"
      )}
    >
      {isUser ? null : (
        <span className="text-muted-foreground mt-0.5 flex size-4 shrink-0 items-center justify-center">
          <BotIcon className="size-4" aria-hidden="true" />
          <span className="sr-only">Ask ReUI reply</span>
        </span>
      )}

      <div
        className={cn(
          "min-w-0 text-sm leading-5",
          isUser
            ? "bg-primary text-primary-foreground max-w-[84%] rounded-xl px-3 py-1.5"
            : "max-w-[calc(100%-1.5rem)]"
        )}
      >
        {isUser ? (
          message.content
        ) : (
          <div className="flex min-w-0 flex-col">
            <div className="text-muted-foreground flex min-w-0 items-center gap-2 text-xs leading-5">
              <span className="text-foreground font-medium">Ask ReUI</span>
              <span>{message.timestamp}</span>
            </div>

            <div className="mt-1.5">
              <p className="text-foreground text-sm leading-5">
                {message.content}
              </p>
            </div>
          </div>
        )}
      </div>
    </article>
  )
}

export function AskReUISheet() {
  const [promptValue, setPromptValue] = useState("")
  const [messages, setMessages] =
    useState<ChatMessageRecord[]>(INITIAL_MESSAGES)
  const chatEndRef = useRef<HTMLDivElement>(null)
  const shouldScrollToLatestRef = useRef(false)

  useEffect(() => {
    if (!shouldScrollToLatestRef.current) {
      return
    }

    shouldScrollToLatestRef.current = false
    chatEndRef.current?.scrollIntoView({ block: "end" })
  }, [messages])

  function sendPrompt(prompt: string) {
    const nextPrompt = prompt.trim()

    if (!nextPrompt) {
      return
    }

    shouldScrollToLatestRef.current = true
    setMessages((currentMessages) => {
      const nextIndex = currentMessages.length + 1

      return [
        ...currentMessages,
        {
          id: `user-${nextIndex}`,
          role: "user",
          timestamp: "Now",
          content: nextPrompt,
        },
        createAssistantReply(nextPrompt, nextIndex + 1),
      ]
    })
    setPromptValue("")
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    sendPrompt(promptValue)
  }

  function handleNewChat() {
    setMessages(INITIAL_MESSAGES)
    setPromptValue("")
  }

  function handleRefreshContext() {
    shouldScrollToLatestRef.current = true
    setMessages((currentMessages) => {
      const nextIndex = currentMessages.length + 1

      return [
        ...currentMessages,
        {
          id: `assistant-refresh-${nextIndex}`,
          role: "assistant",
          timestamp: "Now",
          content:
            "Context refreshed. Current focus: compact sheet behavior, accessible controls, and a pinned composer that stays visually quiet.",
        },
      ]
    })
  }

  return (
    <TooltipProvider delay={180}>
      <Sheet defaultOpen>
        <SheetTrigger
          render={
            <Button type="button" variant="outline" size="lg">
              <SparklesIcon data-icon="inline-start" aria-hidden="true" />
              Open Ask ReUI
            </Button>
          }
        />

        <SheetContent
          side="right"
          showCloseButton={false}
          className="inset-y-4 right-4 left-auto h-[calc(100svh-2rem)] w-[min(28rem,calc(100vw-2rem))] max-w-none overflow-hidden rounded-xl outline-none"
        >
          {/* Header */}
          <SheetHeader className="shrink-0 p-0">
            <div className="flex min-h-12 items-center justify-between gap-2 border-b px-4">
              <div className="flex min-w-0 items-center gap-2">
                <SheetTitle className="truncate text-sm font-medium">
                  Ask ReUI
                </SheetTitle>
              </div>

              {/* Actions */}
              <div className="flex shrink-0 items-center gap-1">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className={mutedIconButtonClassName}
                        onClick={handleNewChat}
                      />
                    }
                  >
                    <SquarePenIcon className="size-3.5" aria-hidden="true" />
                    <span className="sr-only">Start new Ask ReUI chat</span>
                  </TooltipTrigger>
                  <TooltipContent>New chat</TooltipContent>
                </Tooltip>

                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className={mutedIconButtonClassName}
                        onClick={handleRefreshContext}
                      />
                    }
                  >
                    <RefreshCwIcon className="size-3.5" aria-hidden="true" />
                    <span className="sr-only">Refresh Ask ReUI context</span>
                  </TooltipTrigger>
                  <TooltipContent>Refresh context</TooltipContent>
                </Tooltip>

                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Open Ask ReUI actions"
                        className={mutedIconButtonClassName}
                      />
                    }
                  >
                    <MoreHorizontalIcon aria-hidden="true" />
                  </DropdownMenuTrigger>

                  <DropdownMenuContent align="end" className="w-48">
                    <DropdownMenuGroup>
                      <DropdownMenuItem
                        onClick={() =>
                          sendPrompt("Summarize this Ask ReUI thread.")
                        }
                      >
                        <FileTextIcon className="size-4" aria-hidden="true" />
                        Summarize thread
                      </DropdownMenuItem>

                      <DropdownMenuItem
                        onClick={() =>
                          sendPrompt("Draft a short QA checklist for sheet-10.")
                        }
                      >
                        <ListChecksIcon className="size-4" aria-hidden="true" />
                        Draft QA checklist
                      </DropdownMenuItem>

                      <DropdownMenuItem onClick={handleRefreshContext}>
                        <RefreshCwIcon className="size-4" aria-hidden="true" />
                        Refresh context
                      </DropdownMenuItem>

                      <DropdownMenuSeparator />

                      <DropdownMenuItem onClick={handleNewChat}>
                        <Trash2Icon className="size-4" aria-hidden="true" />
                        Clear chat
                      </DropdownMenuItem>
                    </DropdownMenuGroup>
                  </DropdownMenuContent>
                </DropdownMenu>

                <SheetClose
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Close Ask ReUI sheet"
                      className={mutedIconButtonClassName}
                    >
                      <XIcon aria-hidden="true" />
                    </Button>
                  }
                />
              </div>
            </div>

            <SheetDescription className="sr-only">
              Ask ReUI support chat with scrollable conversation history.
            </SheetDescription>
          </SheetHeader>

          {/* Content */}
          <div className="min-h-0 flex-1">
            <ScrollArea className="h-full">
              <div className="flex min-h-full flex-col px-4 pt-3 pb-4">
                <section className="flex flex-col gap-2.5">
                  <h2 className="text-foreground text-lg leading-6 font-medium">
                    What can Ask ReUI help with?
                  </h2>

                  <div className="flex flex-wrap items-center gap-2">
                    {PROMPT_SUGGESTIONS.map((suggestion) => (
                      <Button
                        key={suggestion.id}
                        type="button"
                        variant="outline"
                        onClick={() => setPromptValue(suggestion.prompt)}
                      >
                        {suggestion.label}
                      </Button>
                    ))}
                  </div>
                </section>

                <section className="mt-5 flex flex-col gap-4">
                  {messages.map((message) => (
                    <MessageBubble key={message.id} message={message} />
                  ))}
                  <div ref={chatEndRef} aria-hidden="true" />
                </section>
              </div>
            </ScrollArea>
          </div>

          {/* Footer */}
          <SheetFooter className="shrink-0">
            <form onSubmit={handleSubmit} className="w-full">
              <Field className="gap-2">
                <FieldLabel htmlFor="ask-reui-prompt" className="sr-only">
                  Ask ReUI prompt
                </FieldLabel>

                <InputGroup className="rounded-xl">
                  <InputGroupTextarea
                    id="ask-reui-prompt"
                    value={promptValue}
                    onChange={(event) => setPromptValue(event.target.value)}
                    placeholder="Ask ReUI..."
                    rows={2}
                    autoFocus
                    aria-label="Ask ReUI prompt"
                    className="min-h-16"
                    onKeyDown={(event) => {
                      if (
                        event.key === "Enter" &&
                        (event.metaKey || event.ctrlKey)
                      ) {
                        event.currentTarget.form?.requestSubmit()
                      }
                    }}
                  />

                  <InputGroupAddon
                    align="block-end"
                    className="justify-between gap-2"
                  >
                    <div className="flex items-center gap-1">
                      <InputGroupButton
                        type="button"
                        size="icon-sm"
                        aria-label="Add ReUI context"
                      >
                        <PlusIcon aria-hidden="true" />
                      </InputGroupButton>

                      <InputGroupButton
                        type="button"
                        size="icon-sm"
                        aria-label="Add image"
                      >
                        <ImageIcon aria-hidden="true" />
                      </InputGroupButton>

                      <InputGroupButton
                        type="button"
                        size="icon-sm"
                        aria-label="Use docs context"
                      >
                        <GlobeIcon aria-hidden="true" />
                      </InputGroupButton>
                    </div>

                    <div className="flex items-center gap-1">
                      <InputGroupButton
                        type="button"
                        size="icon-sm"
                        aria-label="Use voice input"
                      >
                        <MicIcon aria-hidden="true" />
                      </InputGroupButton>

                      <InputGroupButton
                        type="submit"
                        variant="default"
                        size="icon-sm"
                        aria-label="Send Ask ReUI prompt"
                      >
                        <ArrowUpIcon aria-hidden="true" />
                      </InputGroupButton>
                    </div>
                  </InputGroupAddon>
                </InputGroup>
              </Field>
            </form>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </TooltipProvider>
  )
}