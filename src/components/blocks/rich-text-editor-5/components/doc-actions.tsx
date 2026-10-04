import { useEffect, useRef, useState, type ReactNode } from "react"
import type { Editor } from "@tiptap/react"
import { toast } from "sonner"

import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Field, FieldLabel } from "@/components/ui/field"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item"
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { DOC_META, PEOPLE } from "./data"
import { resolveChanges, type RichTextMarkupView } from "./rich-text-changes"
import { TriangleAlertIcon, CheckIcon, HighlighterIcon, FileTextIcon, HistoryIcon, Share2Icon, CopyIcon, MoreHorizontalIcon, CodeIcon } from "lucide-react"

type CopyFormat = "final" | "original" | "html"

// Long enough to read the swap, short enough to copy again.
const COPIED_MS = 1600

const TOAST_ERROR_ICON = (
  <TriangleAlertIcon className="text-destructive size-4" aria-hidden="true" />
)

const COPIED_ICON = (
  <CheckIcon aria-hidden="true" />
)

interface ViewOption {
  value: RichTextMarkupView
  label: string
  description: string
  icon: ReactNode
}

const VIEW_OPTIONS: ViewOption[] = [
  {
    value: "all",
    label: "All Markup",
    description: "Every edit, marked in place",
    icon: (
      <HighlighterIcon aria-hidden="true" />
    ),
  },
  {
    value: "final",
    label: "Final",
    description: "As if every edit is accepted",
    icon: (
      <FileTextIcon aria-hidden="true" />
    ),
  },
  {
    value: "original",
    label: "Original",
    description: "The text before any edit",
    icon: (
      <HistoryIcon aria-hidden="true" />
    ),
  },
]

const VIEW_ITEMS = VIEW_OPTIONS.map(({ value, label }) => ({ value, label }))

const VIEW_TRIGGER = Object.fromEntries(
  VIEW_OPTIONS.map((option) => [
    option.value,
    <>
      {option.icon}
      {option.label}
    </>,
  ])
)

const isMarkupView = (value: unknown): value is RichTextMarkupView =>
  VIEW_OPTIONS.some((option) => option.value === value)

async function writeClipboard(value: string) {
  try {
    await navigator.clipboard.writeText(value)
    return true
  } catch {
    toast.error("Copy failed", {
      icon: TOAST_ERROR_ICON,
      description: "The browser blocked clipboard access.",
    })
    return false
  }
}

/** The plain text as if every suggestion were accepted, or all rejected. */
function resolvedText(editor: Editor, resolution: "accept" | "reject") {
  const tr = editor.state.tr
  resolveChanges(tr, resolution, null)
  return tr.doc.textBetween(0, tr.doc.content.size, "\n\n")
}

/** A copy that confirms in place for a moment; only a failure toasts. */
function useCopied<T extends string>() {
  const [copied, setCopied] = useState<T | null>(null)
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(timer.current), [])

  async function copy(target: T, value: string) {
    if (!(await writeClipboard(value))) return
    setCopied(target)
    window.clearTimeout(timer.current)
    // Frozen demo guard: ?demo=frozen pins the demo, so no timer starts.
    if (document.documentElement.dataset.demo === "frozen") return
    timer.current = window.setTimeout(() => setCopied(null), COPIED_MS)
  }

  return [copied, copy] as const
}

interface ViewProps {
  view: RichTextMarkupView
  onViewChange: (view: RichTextMarkupView) => void
  /** No suggestion in the text, so every view reads the same. */
  disabled: boolean
}

/** All Markup, Final or Original: how suggestions read in the page. */
export function ViewSelect({ view, onViewChange, disabled }: ViewProps) {
  return (
    <Select
      items={VIEW_ITEMS}
      value={view}
      disabled={disabled}
      onValueChange={(next) => {
        if (isMarkupView(next)) onViewChange(next)
      }}
    >
      <SelectTrigger size="sm" aria-label="Suggestion view">
        <SelectValue>{VIEW_TRIGGER[view]}</SelectValue>
      </SelectTrigger>
      <SelectContent
        align="end"
        alignItemWithTrigger={false}
        className="min-w-60"
      >
        <SelectGroup>
          {VIEW_OPTIONS.map((option) => (
            <SelectItem
              key={option.value}
              value={option.value}
              className="items-start"
            >
              <span className="flex min-w-0 items-start gap-2">
                <span className="text-muted-foreground flex h-5 shrink-0 items-center">
                  {option.icon}
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className="font-medium">{option.label}</span>
                  <span className="text-muted-foreground text-xs">
                    {option.description}
                  </span>
                </span>
              </span>
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}

/** The plan's link to copy and everyone who can open it. */
export function SharePopover() {
  const [copied, copy] = useCopied<"link">()
  const copyRef = useRef<HTMLButtonElement | null>(null)

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button type="button" size="sm" className="max-sm:w-8 max-sm:px-0" />
        }
      >
        <Share2Icon data-icon="inline-start" aria-hidden="true" />
        <span className="max-sm:sr-only">Share</span>
      </PopoverTrigger>
      <PopoverContent align="end" initialFocus={copyRef} className="w-80">
        <PopoverHeader>
          <PopoverTitle>Share Plan</PopoverTitle>
          <PopoverDescription>
            {PEOPLE.length} people can open it.
          </PopoverDescription>
        </PopoverHeader>
        <Field>
          <FieldLabel htmlFor="plan-link">Plan link</FieldLabel>
          <InputGroup>
            <InputGroupInput
              id="plan-link"
              readOnly
              value={DOC_META.shareUrl}
              onFocus={(event) => event.currentTarget.select()}
            />
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                ref={copyRef}
                size="icon-xs"
                aria-label={copied ? "Link copied" : "Copy link"}
                onClick={() => void copy("link", DOC_META.shareUrl)}
              >
                {copied ? (
                  <CheckIcon className="text-success" aria-hidden="true" />
                ) : (
                  <CopyIcon aria-hidden="true" />
                )}
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        </Field>
        <ItemGroup aria-label="People with access">
          {PEOPLE.map((person) => (
            <Item key={person.id} size="xs">
              <ItemMedia>
                <Avatar size="sm">
                  <AvatarImage src={person.avatar} alt="" />
                  <AvatarFallback>{person.initials}</AvatarFallback>
                </Avatar>
              </ItemMedia>
              <ItemContent className="min-w-0">
                <ItemTitle className="truncate">{person.name}</ItemTitle>
                <ItemDescription className="truncate">
                  {person.role}
                </ItemDescription>
              </ItemContent>
              <ItemActions className="text-muted-foreground text-xs">
                {person.access}
              </ItemActions>
            </Item>
          ))}
        </ItemGroup>
      </PopoverContent>
    </Popover>
  )
}

interface DocMenuProps extends ViewProps {
  editor: Editor | null
}

/** The view again, for narrow headers, and the text out in three forms. */
export function DocMenu({
  editor,
  view,
  onViewChange,
  disabled,
}: DocMenuProps) {
  const [copied, copy] = useCopied<CopyFormat>()

  function copyAs(format: CopyFormat) {
    if (!editor) return
    void copy(
      format,
      format === "html"
        ? editor.getHTML()
        : resolvedText(editor, format === "final" ? "accept" : "reject")
    )
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Document actions"
          />
        }
      >
        <MoreHorizontalIcon aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Suggestions</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={view}
            onValueChange={(next) => {
              if (isMarkupView(next)) onViewChange(next)
            }}
          >
            {VIEW_OPTIONS.map((option) => (
              <DropdownMenuRadioItem
                key={option.value}
                value={option.value}
                disabled={disabled}
                closeOnClick
              >
                {option.icon}
                {option.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>Export</DropdownMenuLabel>
          {/* Stays open, so the swap to Copied is seen where it was clicked. */}
          <DropdownMenuItem
            closeOnClick={false}
            disabled={!editor}
            onClick={() => copyAs("final")}
          >
            {copied === "final" ? (
              COPIED_ICON
            ) : (
              <FileTextIcon aria-hidden="true" />
            )}
            {copied === "final" ? "Copied" : "Copy Final Text"}
          </DropdownMenuItem>
          <DropdownMenuItem
            closeOnClick={false}
            disabled={!editor}
            onClick={() => copyAs("original")}
          >
            {copied === "original" ? (
              COPIED_ICON
            ) : (
              <CopyIcon aria-hidden="true" />
            )}
            {copied === "original" ? "Copied" : "Copy Original Text"}
          </DropdownMenuItem>
          <DropdownMenuItem
            closeOnClick={false}
            disabled={!editor}
            onClick={() => copyAs("html")}
          >
            {copied === "html" ? (
              COPIED_ICON
            ) : (
              <CodeIcon aria-hidden="true" />
            )}
            {copied === "html" ? "Copied" : "Copy Redline HTML"}
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}