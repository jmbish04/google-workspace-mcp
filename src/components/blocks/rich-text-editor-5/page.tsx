import { DocAssistant } from "./components/doc-assistant"

export function Page() {
  return (
    <div className="flex min-h-svh w-full flex-col">
      <DocAssistant className="flex-1" />
    </div>
  )
}