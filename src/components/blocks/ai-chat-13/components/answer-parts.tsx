import { memo, useState, type ReactNode } from "react"
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/reui/alert"
import { Badge } from "@/components/reui/badge"
import {
  CodeBlock,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockTitle,
} from "@/components/reui/code-block/code-block"
import { cn } from "cn"

import { Button } from "@/components/ui/button"
import {
  Item,
  ItemContent,
  ItemHeader,
  ItemTitle,
} from "@/components/ui/item"
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  cellText,
  columnTotal,
  STATUS_BADGE,
  type AnswerBody,
  type AnswerTable,
  type FigureRecord,
} from "./data"
import { CopyIcon, CheckIcon, TriangleAlertIcon, CircleCheckIcon } from "lucide-react"

/** Opacity only: a transform entrance would nudge the scroll height mid-follow. */
export const ITEM_ENTRANCE =
  "animate-in fade-in-0 duration-180 ease-out motion-reduce:animate-none"

/** `code` and **bold**, captured so split keeps the markers. */
const INLINE_PATTERN = /(`[^`]+`|\*\*[^*]+\*\*)/g

const ICON_COPY = (
  <CopyIcon aria-hidden="true" />
)

const ICON_COPIED = (
  <CheckIcon aria-hidden="true" />
)

const ICON_WARNING = (
  <TriangleAlertIcon aria-hidden="true" />
)

const ICON_SUCCESS = (
  <CircleCheckIcon aria-hidden="true" />
)

/** Hands text to the clipboard; rejects where the browser does not allow it. */
function copyText(text: string) {
  if (typeof navigator === "undefined" || !navigator.clipboard)
    return Promise.reject(new Error("Clipboard unavailable"))
  return navigator.clipboard.writeText(text)
}

/** Prose with its inline runs: code in mono, bold as strong. */
export function InlineText({ text }: { text: string }) {
  return text.split(INLINE_PATTERN).map((token, index): ReactNode => {
    if (token.startsWith("`") && token.endsWith("`") && token.length > 1)
      return (
        <code key={index} className="font-mono text-[0.85em]">
          {token.slice(1, -1)}
        </code>
      )
    if (token.startsWith("**") && token.endsWith("**") && token.length > 4)
      return (
        <strong key={index} className="text-foreground font-semibold">
          {token.slice(2, -2)}
        </strong>
      )
    return token
  })
}

/** A ghost icon button that copies text and confirms only a copy that landed;
    the check resets when the pointer or focus leaves, so no timer is needed. */
export function CopyButton({
  text,
  label,
  tooltip,
  status,
  size = "icon-sm",
}: {
  text: string
  label: string
  tooltip: string
  /** What a screen reader hears once the copy lands. */
  status: string
  size?: "icon-sm" | "icon-xs"
}) {
  const [copied, setCopied] = useState(false)

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              size={size}
              variant="ghost"
              aria-label={label}
              onClick={() =>
                copyText(text).then(
                  () => setCopied(true),
                  () => setCopied(false)
                )
              }
              onMouseLeave={() => setCopied(false)}
              onBlur={() => setCopied(false)}
              className="text-muted-foreground hover:text-foreground"
            />
          }
        >
          {copied ? ICON_COPIED : ICON_COPY}
        </TooltipTrigger>
        <TooltipContent>{tooltip}</TooltipContent>
      </Tooltip>
      <span role="status" className="sr-only">
        {copied ? status : ""}
      </span>
    </>
  )
}

/** The numbers an answer rests on, in one row under the lead. */
export function FiguresPart({
  figures,
  entering,
}: {
  figures: FigureRecord[]
  /** The fade each figure lands with while the answer types. */
  entering?: string
}) {
  return (
    <div className="flex items-end gap-4">
      {figures.map((figure) => (
        <div
          key={figure.label}
          className={cn("flex min-w-0 flex-col gap-0.5", entering)}
        >
          <span className="text-lg leading-none font-semibold tabular-nums">
            {figure.value}
          </span>
          <span className="text-muted-foreground truncate text-xs">
            {figure.label}
          </span>
        </div>
      ))}
    </div>
  )
}

/** A comparison the reader scans by column. Rows land one at a time, and the
    total waits for the last of them. */
export const TablePart = memo(function TablePart({
  table,
  rowCount,
  streaming,
  entering,
}: {
  table: AnswerTable
  rowCount: number
  streaming: boolean
  entering?: string
}) {
  const first = table.columns[0]
  const hasTotal = table.columns.some((column) => column.total)

  return (
    <Table className={cn("text-xs", entering)}>
      <TableCaption className="sr-only">{table.caption}</TableCaption>
      <TableHeader>
        <TableRow>
          {table.columns.map((column) => (
            <TableHead
              key={column.key}
              className={column.numeric ? "text-end" : undefined}
            >
              {column.label}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {table.rows.slice(0, rowCount).map((row) => (
          <TableRow key={String(row[first.key])} className={entering}>
            {table.columns.map((column) => {
              const value = row[column.key]
              const status = column.badge
                ? STATUS_BADGE[String(value)]
                : undefined
              return (
                <TableCell
                  key={column.key}
                  className={cn(
                    column.numeric && "text-end tabular-nums",
                    // An identifier may break at its space on a phone, so the
                    // table never scrolls sideways inside the bubble.
                    column.mono && "font-mono whitespace-normal",
                    column === first && !column.mono && "font-medium"
                  )}
                >
                  {status ? (
                    <Badge variant={status.variant}>{status.label}</Badge>
                  ) : (
                    cellText(value, column)
                  )}
                </TableCell>
              )
            })}
          </TableRow>
        ))}
      </TableBody>
      {hasTotal && !streaming ? (
        <TableFooter>
          <TableRow>
            {table.columns.map((column, index) => (
              <TableCell
                key={column.key}
                className={column.numeric ? "text-end tabular-nums" : undefined}
              >
                {index === 0
                  ? "Total"
                  : column.total
                    ? cellText(columnTotal(table, column.key), column)
                    : null}
              </TableCell>
            ))}
          </TableRow>
        </TableFooter>
      ) : null}
    </Table>
  )
})

/** A snippet to run as written. Memoised on its text, so the reveal's ticks
    re-render it only when a line lands. */
export const CodePart = memo(function CodePart({
  language,
  filename,
  code,
  streaming,
  entering,
}: NonNullable<AnswerBody["code"]> & {
  streaming: boolean
  entering?: string
}) {
  return (
    // w-full fills the column instead of sizing to the widest line; "Reply
    // ready" already announces the finished answer, so the block stays quiet.
    <CodeBlock
      code={code}
      language={language}
      streaming={streaming}
      completeAnnouncement=""
      className={cn("w-full min-w-0", entering)}
    >
      <CodeBlockHeader>
        <CodeBlockTitle>{filename}</CodeBlockTitle>
        <Tooltip>
          {/* The tooltip rides a wrapper: rendered as the button it would
              replace the primitive's own onClick. */}
          <TooltipTrigger render={<span className="ms-auto inline-flex" />}>
            <CodeBlockCopyButton />
          </TooltipTrigger>
          <TooltipContent>Copy code</TooltipContent>
        </Tooltip>
      </CodeBlockHeader>
    </CodeBlock>
  )
})

/** Text for the reader to paste elsewhere, with its own Copy so the prose
    around it stays behind. */
export function DraftPart({
  title,
  text,
  fullText,
  entering,
}: {
  title: string
  /** What has arrived so far. */
  text: string
  /** What Copy hands over, even while the rest is still typing. */
  fullText: string
  entering?: string
}) {
  return (
    <Item variant="muted" size="sm" className={entering}>
      <ItemHeader>
        <ItemTitle>{title}</ItemTitle>
        <CopyButton
          text={fullText}
          label="Copy draft"
          tooltip="Copy draft"
          status="Draft copied"
          size="icon-xs"
        />
      </ItemHeader>
      <ItemContent>
        <p className="text-sm leading-relaxed">{text}</p>
      </ItemContent>
    </Item>
  )
}

/** The caveat or all clear that must not read as one more sentence. */
export function CalloutPart({
  tone,
  title,
  detail,
  entering,
}: NonNullable<AnswerBody["callout"]> & { entering?: string }) {
  return (
    // A note, not an alert: an alert role would announce again on every reload.
    <Alert variant={tone} role="note" className={entering}>
      {tone === "warning" ? ICON_WARNING : ICON_SUCCESS}
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <p>
          <InlineText text={detail} />
        </p>
      </AlertDescription>
    </Alert>
  )
}