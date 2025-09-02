import type { Terminal } from "@xterm/xterm"
import { LatexHashMap, type LatexEntry } from "./latex-hashmap.js"
import katex from "katex"

/**
 * OverlayManager - Manages KaTeX rendered overlays positioned over terminal grid
 * Scans terminal buffer for «evmXXXXX» patterns and creates/updates overlays
 */
export class OverlayManager {
	private terminal: Terminal
	private latexMap: LatexHashMap
	private overlayContainer: HTMLDivElement
	private overlays: Map<string, HTMLDivElement> = new Map()
	private enabled: boolean = true
	private scrollDebounceTimer: number | null = null
	
	constructor(terminal: Terminal, latexMap: LatexHashMap) {
		this.terminal = terminal
		this.latexMap = latexMap
		
		// Create overlay container
		this.overlayContainer = document.createElement('div')
		this.overlayContainer.className = 'latex-overlay-container'
		this.overlayContainer.style.cssText = `
			position: absolute;
			top: 0;
			left: 0;
			width: 100%;
			height: 100%;
			pointer-events: none;
			z-index: 100;
			overflow: hidden;
		`
		
		// Add global styles to reduce KaTeX spacing
		const styleElement = document.createElement('style')
		styleElement.textContent = `
			.latex-overlay-container .katex {
				margin: 0 !important;
				vertical-align: baseline !important;
			}
			.latex-overlay-container .katex-display {
				margin: 0 !important;
				padding: 0 !important;
			}
			.latex-overlay-container .katex .base {
				vertical-align: baseline !important;
			}
			.latex-overlay-container .katex-html {
				padding: 0 !important;
			}
		`
		this.overlayContainer.appendChild(styleElement)
		
		// Attach directly to terminal element (xterm container)
		const terminalElement = terminal.element
		if (terminalElement) {
			terminalElement.style.position = 'relative'
			terminalElement.appendChild(this.overlayContainer)
		}
		
		// Hook terminal events
		this.hookTerminalEvents()
	}
	
	/**
	 * Hook into terminal events for updating overlays
	 */
	private hookTerminalEvents(): void {
		// Update on render (viewport changes)
		this.terminal.onRender(() => {
			if (this.enabled) {
				this.updateOverlays()
			}
		})
		
		// Update on scroll with debouncing
		this.terminal.onScroll(() => {
			if (!this.enabled) return
			
			// Clear existing timer
			if (this.scrollDebounceTimer !== null) {
				clearTimeout(this.scrollDebounceTimer)
			}
			
			// Debounce scroll updates
			this.scrollDebounceTimer = window.setTimeout(() => {
				this.updateOverlays()
				this.scrollDebounceTimer = null
			}, 50)
		})
		
		// Update on resize
		this.terminal.onResize(() => {
			if (this.enabled) {
				// Clear all overlays on resize as positions change
				this.clearAllOverlays()
				// Rebuild after a short delay
				setTimeout(() => this.updateOverlays(), 100)
			}
		})
	}
	
	/**
	 * Render LaTeX to HTML using KaTeX with caching
	 */
	private renderLatex(entry: LatexEntry): string {
		// Return cached render if available
		if (entry.renderedHTML) {
			return entry.renderedHTML
		}
		
		// Return error if previously failed
		if (entry.renderError) {
			return `<span style="color: red; font-family: monospace;">[LaTeX Error]</span>`
		}
		
		try {
			// Render with KaTeX
			const html = katex.renderToString(entry.latex, {
				throwOnError: false,
				displayMode: entry.displayHeight > 1, // Use display mode for tall expressions
				output: 'html',
				trust: false,
				strict: false
			})
			
			// Cache the result
			entry.renderedHTML = html
			return html
		} catch (error) {
			// Cache the error
			entry.renderError = error instanceof Error ? error.message : 'Unknown error'
			console.error(`[LaTerM] KaTeX render error for "${entry.latex}":`, error)
			return `<span style="color: red; font-family: monospace;">[LaTeX Error]</span>`
		}
	}
	
	/**
	 * Get terminal cell dimensions
	 */
	private getCellDimensions(): { width: number, height: number } {
		// Access internal dimensions (may need adjustment based on xterm version)
		const renderer = (this.terminal as any)._core?._renderService
		if (renderer && renderer.dimensions) {
			return {
				width: renderer.dimensions.actualCellWidth || 9,
				height: renderer.dimensions.actualCellHeight || 17
			}
		}
		
		// Fallback dimensions
		return { width: 9, height: 17 }
	}
	
	/**
	 * Create or update an overlay for a hash at a specific position
	 */
	private createOrUpdateOverlay(hash: string, row: number, col: number): void {
		const entry = this.latexMap.get(hash)
		if (!entry) {
			console.log(`[LaTerM] No entry found for hash ${hash}`)
			return
		}
		console.log(`[LaTerM] Creating overlay for LaTeX: ${entry.latex}`)
		
		// Get or create overlay element
		let overlay = this.overlays.get(hash)
		if (!overlay) {
			overlay = document.createElement('div')
			overlay.className = 'latex-overlay'
			overlay.dataset['hash'] = hash
			// Get terminal font size to match
			const cellDims = this.getCellDimensions()
			overlay.style.cssText = `
				position: absolute;
				pointer-events: none;
				background: var(--background-primary);
				color: var(--text-normal);
				font-size: ${cellDims.height * 0.6}px;
				line-height: 1;
				min-width: ${7 * cellDims.width}px;
				white-space: nowrap;
				padding: 0;
				margin: 0;
				box-sizing: border-box;
				display: inline-block;
			`
			this.overlayContainer.appendChild(overlay)
			this.overlays.set(hash, overlay)
		}
		
		// Render LaTeX content (cached)
		overlay.innerHTML = this.renderLatex(entry)
		
		// Calculate pixel position
		const cellDims = this.getCellDimensions()
		const x = col * cellDims.width
		const y = row * cellDims.height
		
		// Update position and size (cell dimensions may have changed on zoom)
		overlay.style.left = `${x}px`
		overlay.style.top = `${y}px`
		overlay.style.fontSize = `${cellDims.height * 0.6}px`
		overlay.style.minWidth = `${7 * cellDims.width}px`
		// Let width be natural but enforce minimum
		overlay.style.width = 'auto'
		
		// Width should already be correct from pre-rendering
		// Just log if there's a discrepancy for debugging
		if (entry.renderedHTML) {
			setTimeout(() => {
				const actualWidth = Math.ceil(overlay.offsetWidth / cellDims.width)
				if (actualWidth !== entry.displayWidth) {
					console.warn(`[LaTerM] Width mismatch for ${hash}: expected ${entry.displayWidth}, actual ${actualWidth}`)
				}
			}, 10)
		}
		
		// Set max width to prevent overflow
		const maxWidth = (this.terminal.cols - col) * cellDims.width
		overlay.style.maxWidth = `${maxWidth}px`
		
		// Mark as active (for cleanup)
		overlay.dataset['active'] = 'true'
	}
	
	/**
	 * Scan terminal buffer and update all overlays
	 */
	private updateOverlays(): void {
		if (!this.enabled) return
		
		// Mark all overlays as inactive
		this.overlays.forEach(overlay => {
			overlay.dataset['active'] = 'false'
		})
		
		// Get viewport bounds
		const buffer = this.terminal.buffer.active
		const viewportY = buffer.viewportY
		const rows = this.terminal.rows
		
		// Scan visible buffer for hash patterns
		for (let row = 0; row < rows; row++) {
			const line = buffer.getLine(viewportY + row)
			if (!line) continue
			
			const text = line.translateToString()
			
			// Find all ««XXXX» patterns in this line
			const hashRegex = /««([a-f0-9]{4})»/g
			let match
			
			while ((match = hashRegex.exec(text)) !== null) {
				const hash = match[1]
				if (!hash) continue
				const col = match.index
				
				console.log(`[LaTerM] Found hash ${hash} at row ${row}, col ${col}`)
				
				// Create or update overlay at this position
				this.createOrUpdateOverlay(hash, row, col)
			}
		}
		
		// Remove inactive overlays (no longer visible)
		this.overlays.forEach((overlay, hash) => {
			if (overlay.dataset['active'] === 'false') {
				overlay.remove()
				this.overlays.delete(hash)
			}
		})
	}
	
	/**
	 * Clear all overlays
	 */
	private clearAllOverlays(): void {
		this.overlays.forEach(overlay => overlay.remove())
		this.overlays.clear()
	}
	
	/**
	 * Enable or disable the overlay manager
	 */
	public setEnabled(enabled: boolean): void {
		this.enabled = enabled
		if (!enabled) {
			this.clearAllOverlays()
		} else {
			this.updateOverlays()
		}
	}
	
	/**
	 * Clean up resources
	 */
	public dispose(): void {
		// Clear debounce timer
		if (this.scrollDebounceTimer !== null) {
			clearTimeout(this.scrollDebounceTimer)
		}
		
		// Remove all overlays
		this.clearAllOverlays()
		
		// Remove container
		this.overlayContainer.remove()
	}
}