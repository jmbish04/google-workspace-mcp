import { useTheme } from "next-themes"

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
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@/components/ui/toggle-group"
import { ORGANIZATIONS, VIEWER, type OrganizationRecord } from "./data"
import { SunIcon, MoonIcon, MonitorIcon, PlusIcon, UserIcon, CreditCardIcon, SettingsIcon, PaletteIcon, LogOutIcon } from "lucide-react"

const THEMES = [
  {
    value: "light",
    label: "Light",
    icon: (
      <SunIcon aria-hidden="true" />
    ),
  },
  {
    value: "dark",
    label: "Dark",
    icon: (
      <MoonIcon aria-hidden="true" />
    ),
  },
  {
    value: "system",
    label: "System",
    icon: (
      <MonitorIcon aria-hidden="true" />
    ),
  },
]

/** The picked swatch sits on the page surface inside a hairline, the way the
    menu's own edge is drawn. Glyphs inherit, or the row's hover recolors them. */
const THEME_ITEM =
  "text-muted-foreground hover:text-foreground aria-pressed:bg-background aria-pressed:text-foreground aria-pressed:inset-ring aria-pressed:inset-ring-foreground/10 data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:inset-ring data-[state=on]:inset-ring-foreground/10 size-6 min-w-6 rounded-full px-0 **:text-inherit"

function ThemeSegmentedToggle() {
  const { theme, setTheme } = useTheme()
  // The menu mounts on open, long after the theme resolves: no hydration gate.
  const current = theme ?? "system"

  return (
    <ToggleGroup
      multiple={false}
      value={[current]}
      // A theme is always set, so pressing the active one again changes nothing.
      onValueChange={(value) => value[0] && setTheme(value[0])}
      spacing={0.5}
      size="sm"
      aria-label="Theme"
      className="bg-muted/60 rounded-full p-0.5"
    >
      {THEMES.map(({ value, label, icon }) => (
        <ToggleGroupItem
          key={value}
          value={value}
          aria-label={label}
          className={THEME_ITEM}
        >
          {icon}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}

/** A round gradient mark standing in for the organization's logo. */
function OrganizationMark({
  organization,
}: {
  organization: OrganizationRecord
}) {
  const [from, via, to] = organization.gradient
  const gradientId = `ai-chat-13-org-${organization.id}`

  return (
    <svg
      viewBox="0 0 28 28"
      fill="none"
      className="size-5 shrink-0"
      aria-hidden="true"
    >
      <defs>
        <linearGradient
          id={gradientId}
          x1="0"
          y1="0"
          x2="28"
          y2="28"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stopColor={from} />
          <stop offset="50%" stopColor={via} />
          <stop offset="100%" stopColor={to} />
        </linearGradient>
      </defs>
      <circle cx="14" cy="14" r="14" fill={`url(#${gradientId})`} />
    </svg>
  )
}

/**
 * The viewer's avatar in the page header, opening their account menu: who is
 * signed in, which organization is open, account links, theme and sign out.
 */
export function UserMenu({
  organizationId,
  onOrganizationChange,
  className,
}: {
  organizationId: string
  onOrganizationChange: (id: string) => void
  className?: string
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            aria-label="Open user menu"
            className={className}
          />
        }
      >
        <Avatar className="size-6">
          <AvatarImage src={VIEWER.avatar} alt={VIEWER.name} />
          <AvatarFallback className="text-[9px]">
            {VIEWER.initials}
          </AvatarFallback>
        </Avatar>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        side="bottom"
        align="end"
        sideOffset={8}
        className="w-64"
      >
        <DropdownMenuGroup>
          <DropdownMenuLabel className="flex items-center gap-2 py-2">
            <Avatar className="size-6">
              <AvatarImage src={VIEWER.avatar} alt={VIEWER.name} />
              <AvatarFallback className="text-[9px]">
                {VIEWER.initials}
              </AvatarFallback>
            </Avatar>
            <div className="flex min-w-0 flex-col">
              <span className="text-foreground truncate text-sm font-semibold">
                {VIEWER.name}
              </span>
              <span className="text-muted-foreground truncate text-xs">
                {VIEWER.email}
              </span>
            </div>
          </DropdownMenuLabel>
        </DropdownMenuGroup>

        <DropdownMenuSeparator />

        <DropdownMenuGroup>
          <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
            Organizations
          </DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={organizationId}
            onValueChange={onOrganizationChange}
          >
            {ORGANIZATIONS.map((organization) => (
              <DropdownMenuRadioItem
                key={organization.id}
                value={organization.id}
                closeOnClick
              >
                <OrganizationMark organization={organization} />
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-medium">
                    {organization.name}
                  </span>
                  <span className="text-muted-foreground truncate text-xs">
                    {organization.tier}
                  </span>
                </div>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuItem>
            {/* Padded to the marks' width so the label lines up with the names. */}
            <PlusIcon aria-hidden="true" className="mx-0.5" />
            New Organization
          </DropdownMenuItem>
        </DropdownMenuGroup>

        <DropdownMenuSeparator />

        <DropdownMenuGroup>
          <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
            Account
          </DropdownMenuLabel>
          <DropdownMenuItem>
            <UserIcon aria-hidden="true" />
            Profile
            <DropdownMenuShortcut>⇧⌘P</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem>
            <CreditCardIcon aria-hidden="true" />
            Billing
          </DropdownMenuItem>
          <DropdownMenuItem>
            <SettingsIcon aria-hidden="true" />
            Preferences
          </DropdownMenuItem>
          {/* The swatches set a value in place, so the menu outlives the click. */}
          <DropdownMenuItem
            closeOnClick={false}
            className="cursor-default focus:bg-transparent"
          >
            <PaletteIcon aria-hidden="true" />
            Theme
            <div className="ms-auto">
              <ThemeSegmentedToggle />
            </div>
          </DropdownMenuItem>
        </DropdownMenuGroup>

        <DropdownMenuSeparator />

        <DropdownMenuGroup>
          <DropdownMenuItem>
            <LogOutIcon aria-hidden="true" />
            Sign Out
            <DropdownMenuShortcut>⇧⌘Q</DropdownMenuShortcut>
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}