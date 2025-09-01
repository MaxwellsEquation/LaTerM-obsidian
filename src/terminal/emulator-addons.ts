import {
	Functions,
	activeSelf,
	consumeEvent,
	deepFreeze,
	isNonNil,
	replaceAllRegex,
} from "@polyipseity/obsidian-plugin-library"
import type { ITerminalAddon, Terminal } from "@xterm/xterm"
import { constant } from "lodash-es"

export class DisposerAddon extends Functions implements ITerminalAddon {
	public constructor(...args: readonly (() => void)[]) {
		super({ async: false, settled: true }, ...args)
	}

	// eslint-disable-next-line @typescript-eslint/class-methods-use-this
	public activate(_terminal: Terminal): void {
		// Noop
	}

	public dispose(): void {
		this.call()
	}
}

export class DragAndDropAddon implements ITerminalAddon {
	readonly #disposer = new Functions({ async: false, settled: true })

	public constructor(protected readonly element: HTMLElement) { }

	public activate(terminal: Terminal): void {
		const { element } = this,
			drop = (event: DragEvent): void => {
				terminal.paste(Array.from(event.dataTransfer?.files ?? [])
					.map(file => file.path)
					.filter(isNonNil)
					.map(path => path.replace(replaceAllRegex("\""), "\\\""))
					.map(path => path.includes(" ") ? `"${path}"` : path)
					.join(" "))
				consumeEvent(event)
			},
			dragover = consumeEvent
		this.#disposer.push(
			() => { element.removeEventListener("dragover", dragover) },
			() => { element.removeEventListener("drop", drop) },
		)
		element.addEventListener("drop", drop)
		element.addEventListener("dragover", dragover)
	}

	public dispose(): void {
		this.#disposer.call()
	}
}

// RendererAddon removed - DOM-only rendering now

export class RightClickActionAddon implements ITerminalAddon {
	readonly #disposer = new Functions({ async: false, settled: true })

	public constructor(
		protected readonly action: () => RightClickActionAddon.Action =
		constant("default"),
	) { }

	public activate(terminal: Terminal): void {
		const { element } = terminal
		if (!element) { throw new Error() }
		const contextMenuListener = (ev: MouseEvent): void => {
			const action = this.action()
			if (action === "default") { return }
			(async (): Promise<void> => {
				try {
					// eslint-disable-next-line default-case
					switch (action) {
						case "nothing":
							// How to send right click to the terminal?
							break
						// @ts-expect-error: fallthrough
						case "copyPaste":
							if (terminal.hasSelection()) {
								await activeSelf(element).navigator.clipboard
									.writeText(terminal.getSelection())
								terminal.clearSelection()
								break
							}
						// eslint-disable-next-line no-fallthrough
						case "paste":
							terminal.paste(await activeSelf(element).navigator.clipboard
								.readText())
							break
					}
				} catch (error) {
					activeSelf(element).console.error(error)
				}
			})()
			consumeEvent(ev)
		}
		this.#disposer.push(() => {
			element.removeEventListener("contextmenu", contextMenuListener)
		})
		element.addEventListener("contextmenu", contextMenuListener)
	}

	public dispose(): void {
		this.#disposer.call()
	}
}
export namespace RightClickActionAddon {
	export const ACTIONS = deepFreeze([
		"copyPaste", "default", "nothing", "paste",
	])
	export type Action = typeof ACTIONS[number]
}
