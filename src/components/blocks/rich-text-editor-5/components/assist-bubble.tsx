import { isTextSelection, type Editor } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import { SparklesIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";

import { AGENT, type AssistActionId } from "./data";
import { keepEditorFocus } from "./rich-text-toolbar";

const BUBBLE_OPTIONS = { placement: "top", offset: 8 } as const;

// Module scope: a new function each render would re-register the plugin.
function showAtSelection({ editor, element }: { editor: Editor; element: HTMLElement }) {
  const { selection, doc } = editor.state;
  if (!editor.isEditable || !isTextSelection(selection) || selection.empty) {
    return false;
  }
  if (!doc.textBetween(selection.from, selection.to).trim()) return false;
  if (editor.isActive("codeBlock")) return false;
  return editor.view.hasFocus() || element.contains(document.activeElement);
}

interface AssistBubbleProps {
  editor: Editor;
  onAsk: () => void;
  onRun: (id: AssistActionId) => void;
}

/** Over a selection: hand it to the composer, or run a scoped task now. */
export function AssistBubble({ editor, onAsk, onRun }: AssistBubbleProps) {
  return (
    <BubbleMenu
      editor={editor}
      pluginKey="assistSelectionBubble"
      shouldShow={showAtSelection}
      options={BUBBLE_OPTIONS}
      className="z-50"
    >
      <ButtonGroup aria-label={`${AGENT.name} on selection`}>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onMouseDown={keepEditorFocus}
          onClick={onAsk}
          className="text-primary"
        >
          <SparklesIcon data-icon="inline-start" aria-hidden="true" />
          Ask {AGENT.name}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onMouseDown={keepEditorFocus}
          onClick={() => onRun("tighten")}
        >
          Tighten
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onMouseDown={keepEditorFocus}
          onClick={() => onRun("firmer")}
        >
          Firmer Tone
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onMouseDown={keepEditorFocus}
          onClick={() => onRun("bullet_list")}
        >
          Bullet List
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onMouseDown={keepEditorFocus}
          onClick={() => onRun("proofread")}
        >
          Fix Spelling
        </Button>
      </ButtonGroup>
    </BubbleMenu>
  );
}
