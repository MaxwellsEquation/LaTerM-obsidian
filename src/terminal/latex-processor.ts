import type { Terminal } from "@xterm/xterm"
import { LatexHashMap, type LatexEntry } from "./latex-hashmap.js"
import katex from "katex"
import * as fs from "fs"
import * as path from "path"

/**
 * LatexProcessor - Intercepts terminal.write() to detect and replace LaTeX with hash placeholders
 * Works in conjunction with LatexHashMap to store expressions for later rendering
 */
export class LatexProcessor {
	private terminal: Terminal
	private latexMap: LatexHashMap
	private buffer: string = ''  // For incomplete LaTeX at chunk boundaries
	private originalWrite: (data: string | Uint8Array, callback?: () => void) => void
	private enabled: boolean = true
	private loggingEnabled: boolean
	private logStream: fs.WriteStream | null = null
	private processCount: number = 0
	private inAlternateScreen: boolean = false
	
	constructor(terminal: Terminal, loggingEnabled: boolean, vaultPath: string) {
		this.terminal = terminal
		this.latexMap = new LatexHashMap()
		this.loggingEnabled = loggingEnabled
		
		// Store original write function
		this.originalWrite = terminal.write.bind(terminal)
		
		// Set up logging if enabled
		if (loggingEnabled) {
			try {
				const logDir = path.join(vaultPath, '.obsidian', 'plugins', 'laterm', 'logs')
				if (!fs.existsSync(logDir)) {
					fs.mkdirSync(logDir, { recursive: true })
				}
				
				const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
				const logPath = path.join(logDir, `latex-processor-${timestamp}.log`)
				this.logStream = fs.createWriteStream(logPath, { flags: 'a' })
				
				this.log(`[LaTeX Processor] Started at ${new Date().toISOString()}`)
				this.log(`[LaTeX Processor] Log file: ${logPath}`)
				console.log(`[LaTerM] LaTeX processor logs: ${logPath}`)
			} catch (error) {
				console.error(`[LaTerM] Failed to create processor log: ${error}`)
			}
		}
		
		// Hook terminal.write
		this.hookTerminalWrite()
	}
	
	/**
	 * Render LaTeX and measure its width in terminal cells
	 */
	private renderAndMeasure(latex: string, isDisplay: boolean = false): { html: string, width: number, pixelWidth: number, error?: string } {
		try {
			// Render with KaTeX
			const html = katex.renderToString(latex, {
				throwOnError: false,
				displayMode: isDisplay,
				output: 'html',
				trust: false,
				strict: false
			})
			
			// Get terminal font size for accurate measurement
			const renderer = (this.terminal as any)._core._renderService
			const fontSize = renderer.dimensions.actualCellHeight * 0.7
			
			// Create temporary element to measure
			const measurer = document.createElement('div')
			measurer.style.cssText = `
				position: absolute;
				visibility: hidden;
				height: auto;
				width: auto;
				white-space: nowrap;
				font-family: monospace;
				font-size: ${fontSize}px;
				line-height: 1;
				padding: 0;
				display: inline-block;
			`
			measurer.innerHTML = html
			document.body.appendChild(measurer)
			
			// Measure and calculate terminal cells needed
			const pixelWidth = measurer.offsetWidth
			// Calculate cell width the same way as overlay manager for consistency
			const termElement = this.terminal.element
			if (!termElement) {
				console.error('[LaTerM] Terminal element not available')
				return { html, width: 7, pixelWidth, error: 'Terminal element not found' }
			}
			
			const viewport = termElement.querySelector('.xterm-viewport') as HTMLElement
			const screen = termElement.querySelector('.xterm-screen') as HTMLElement
			const element = screen || viewport || termElement
			const cellWidth = element.clientWidth / this.terminal.cols
			
			console.log(`[LaTerM DEBUG] Measurement: pixelWidth=${pixelWidth}, cellWidth=${cellWidth}, cols=${this.terminal.cols}`)
			
			if (!cellWidth || cellWidth <= 0) {
				console.error(`[LaTerM] Invalid cellWidth calculation: ${cellWidth}`)
				return { html, width: 7, pixelWidth, error: 'Invalid cell width' }
			}
			
			// Calculate cells needed without extra padding
			const division = pixelWidth / cellWidth
			const cells = Math.round(division)
			const finalWidth = Math.max(cells, 7)
			
			console.log(`[LaTerM DEBUG] Width calc: ${pixelWidth}/${cellWidth} = ${division}, ceil = ${cells}, final = ${finalWidth}`)
			
			// Clean up
			document.body.removeChild(measurer)
			
			return { html, width: finalWidth, pixelWidth }
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : 'Unknown error'
			console.error(`[LaTerM] KaTeX render error for "${latex}":`, error)
			// Return error placeholder
			return { 
				html: `<span style="color: red; font-family: monospace;">[LaTeX Error]</span>`,
				width: 12,
				pixelWidth: 120, // Approximate for error message
				error: errorMsg
			}
		}
	}
	
	/**
	 * Hook into terminal.write to process LaTeX
	 */
	private hookTerminalWrite(): void {
		this.terminal.write = (data: string | Uint8Array, callback?: () => void) => {
			if (!this.enabled || this.inAlternateScreen || typeof data !== 'string') {
				// Pass through without processing
				return this.originalWrite(data, callback)
			}
			
			// Detect alternate screen commands
			if (data.includes('\x1b[?1049h')) {
				this.inAlternateScreen = true
				this.log(`[LaTeX Processor] Entering alternate screen`)
				return this.originalWrite(data, callback)
			} else if (data.includes('\x1b[?1049l')) {
				this.inAlternateScreen = false
				this.log(`[LaTeX Processor] Exiting alternate screen`)
				return this.originalWrite(data, callback)
			}
			
			// Process LaTeX in the data
			const processed = this.processLatex(data)
			
			// Log if different from original
			if (processed !== data && this.loggingEnabled) {
				this.processCount++
				this.log(`\n[Process #${this.processCount}] ===================================`)
				this.log(`[Original]: ${this.getSafePreview(data, 200)}`)
				this.log(`[Processed]: ${this.getSafePreview(processed, 200)}`)
				this.log(`[Buffer State]: "${this.buffer}"`)
				this.log(`[HashMap Stats]: ${JSON.stringify(this.latexMap.getStats())}`)
			}
			
			return this.originalWrite(processed, callback)
		}
	}
	
	/**
	 * Process LaTeX expressions in text
	 */
	private processLatex(text: string): string {
		// Combine with any buffered incomplete LaTeX
		const combined = this.buffer + text
		this.buffer = ''
		
		let result = combined
		let replacementCount = 0
		
		// Process display LaTeX first: $$...$$
		// Relaxed requirements - any non-empty content between $$...$$ is treated as LaTeX
		result = result.replace(/\$\$([^$]+?)\$\$/g, (_, latex) => {
			// Replace || with \\ for LaTeX row separators (PTY-safe alternative)
			latex = latex.replace(/\|\|/g, '\\\\')
			// Remove newlines that are likely from terminal wrapping
			latex = latex.replace(/\n\s*/g, ' ')
			replacementCount++
			
			// Generate hash
			const hash = this.latexMap.generateHash(latex)
			
			// Render and measure IMMEDIATELY
			const { html, width, pixelWidth, error } = this.renderAndMeasure(latex, true)
			
			// Get current cell dimensions using public API
			const cellDims = this.getCellDimensions()
			const cellWidth = cellDims.width
			const cellHeight = cellDims.height
			
			// Store in hashmap with rendered HTML - mark as display equation
			const entry: LatexEntry = {
				latex: latex,
				displayWidth: width,
				displayHeight: 1,
				pixelWidth: pixelWidth,
				originalCellWidth: cellWidth,
				originalCellHeight: cellHeight,
				isDisplayEquation: true,  // Mark as display equation for centering
				...(error ? { renderError: error } : { renderedHTML: html })
			}
			this.latexMap.set(hash, entry)
			
			// Create placeholder with measured width
			const placeholder = this.latexMap.formatPlaceholder(hash, width)
			
			// Log the replacement
			if (this.loggingEnabled) {
				this.log(`  [Display LaTeX Found #${replacementCount}]`)
				this.log(`    Expression: ${latex}`)
				this.log(`    Hash: ${hash}`)
				this.log(`    Measured width: ${width} cells`)
				this.log(`    Placeholder: "${placeholder}"`)
			}
			
			// Add newlines above and below for display equations
			return `\n${placeholder}\n`
		})
		
		// Then process inline LaTeX: $...$
		// Smart filtering: small expressions (<5 chars) OR larger ones (<30 chars) with math operators
		result = result.replace(/\$([^$]+?)\$/g, (match, latex) => {
			try {
				// Debug: Log every regex match
				console.log(`[LaTerM DEBUG] Processing regex match: "${match}" with latex: "${latex}"`)
				
				// Replace || with \\ for LaTeX row separators (PTY-safe alternative)
				let cleanLatex = latex.replace(/\|\|/g, '\\\\')
				// Remove newlines that are likely from terminal wrapping
				cleanLatex = cleanLatex.replace(/\n\s*/g, '').trim()
				
				// Check if expression meets criteria for LaTeX processing
				const isSmall = cleanLatex.length < 7
				const isMathExpression = cleanLatex.length < 150 && (/[+=><^\\]/.test(cleanLatex))
				
				console.log(`[LaTerM DEBUG] Filter check: isSmall=${isSmall}, isMathExpression=${isMathExpression}`)
				
				if (!isSmall && !isMathExpression) {
					// Not a valid LaTeX candidate, return unchanged
					console.log(`[LaTerM DEBUG] Returning unchanged: "${match}"`)
					if (this.loggingEnabled) {
						this.log(`  [Inline LaTeX Skipped] "${cleanLatex}" - doesn't meet criteria`)
					}
					return match  // Return original $...$
				}
				
				// Try to render to validate it's actually LaTeX
				console.log(`[LaTerM DEBUG] Testing render for: "${cleanLatex}"`)
				const testRender = this.renderAndMeasure(cleanLatex, false)
				if (testRender.error) {
					// Rendering failed, treat as false positive
					console.log(`[LaTerM DEBUG] Render failed, returning unchanged: "${match}"`)
					if (this.loggingEnabled) {
						this.log(`  [Inline LaTeX False Positive] "${cleanLatex}" - render failed: ${testRender.error}`)
					}
					return match  // Return original $...$
				}
				
				console.log(`[LaTerM DEBUG] Render successful, proceeding with replacement`)
				replacementCount++
				
				// Generate hash
				const hash = this.latexMap.generateHash(cleanLatex)
				
				// Get current cell dimensions using public API
				const cellDims = this.getCellDimensions()
				const cellWidth = cellDims.width
				const cellHeight = cellDims.height
				
				// Store in hashmap with rendered HTML
				const entry: LatexEntry = {
					latex: cleanLatex,
					displayWidth: testRender.width,
					displayHeight: 1,
					pixelWidth: testRender.pixelWidth,
					originalCellWidth: cellWidth,
					originalCellHeight: cellHeight,
					renderedHTML: testRender.html
				}
				this.latexMap.set(hash, entry)
				
				// Create placeholder with actual content width to properly space following text
				const contentCells = Math.floor(testRender.pixelWidth / cellWidth)
				// TODO HACK: Magic adjustment to compensate for cellWidth measurement inaccuracy
				// Consistently overestimates by 3-4 spaces, so subtract 2 to reduce excess
				const adjustedCells = Math.max(contentCells - 2, 7)
				const placeholderWidth = adjustedCells
				const placeholder = this.latexMap.formatPlaceholder(hash, placeholderWidth)
				
				// Debug: Force log this critical step
				console.log(`[LaTerM DEBUG] About to return placeholder for "${cleanLatex}": "${placeholder}"`)
				
				// Log the replacement
				if (this.loggingEnabled) {
					this.log(`  [Inline LaTeX Found #${replacementCount}]`)
					this.log(`    Expression: ${cleanLatex}`)
					this.log(`    Hash: ${hash}`)
					this.log(`    Measured width: ${testRender.width} cells`)
					this.log(`    Placeholder: "${placeholder}"`)
				}
				
				return placeholder
			} catch (error) {
				console.error(`[LaTerM ERROR] Exception in regex callback:`, error)
				return match  // Return original on error
			}
		})
		
		// Check for incomplete LaTeX at the end
		// Look for either $ or $$ that might be incomplete
		const lastSingle = result.lastIndexOf('$')
		const lastDouble = result.lastIndexOf('$$')
		const lastNewline = result.lastIndexOf('\n')
		
		// Use the most recent dollar sign(s)
		const lastDollar = Math.max(lastSingle, lastDouble)
		
		if (lastDollar > lastNewline && lastDollar !== -1) {
			const isDoubleDollar = lastDouble === lastDollar
			const dollarOffset = isDoubleDollar ? 2 : 1
			const beforeDollar = result.substring(Math.max(0, lastDollar - 20), lastDollar)
			const afterDollar = result.substring(lastDollar + dollarOffset)
			
			// Common LaTeX patterns that suggest we should buffer
			const latexPatterns = [
				'\\frac', '\\sqrt', '\\sum', '\\int', '\\nabla', '\\partial',
				'\\alpha', '\\beta', '\\gamma', '\\theta', '\\phi', '\\psi',
				'\\begin', '\\end', '\\left', '\\right',
				'^{', '_{', '\\cdot', '\\times', '\\div', '\\mathbf', '\\text'
			]
			
			// Only buffer if:
			// 1. No closing $ or $$ yet
			// 2. For $: Contains LaTeX-like patterns
			// 3. For $$: Always buffer (display math is intentional)
			// 4. Not a shell prompt ($ followed by space or at end)
			// 5. Buffer is reasonably small (under 100 chars for display math)
			const potentialBuffer = result.substring(lastDollar)
			const looksLikeLatex = latexPatterns.some(p => afterDollar.includes(p)) || 
			                       latexPatterns.some(p => beforeDollar.includes(p))
			const isShellPrompt = !isDoubleDollar && (afterDollar.match(/^\s/) || afterDollar === '')
			const maxBufferSize = isDoubleDollar ? 100 : 50
			
			// For $$, always buffer. For $, need LaTeX patterns
			const shouldBuffer = isDoubleDollar || looksLikeLatex
			
			if (!afterDollar.includes(isDoubleDollar ? '$$' : '$') && 
			    !afterDollar.includes('\n') && 
			    shouldBuffer && 
			    !isShellPrompt &&
			    potentialBuffer.length < maxBufferSize) {
				this.buffer = potentialBuffer
				result = result.substring(0, lastDollar)
				
				if (this.loggingEnabled) {
					this.log(`  [Buffered Incomplete]: "${this.buffer}"`)
				}
			}
		}
		
		// Clear buffer if it's been too long (stale)
		if (this.buffer.length > 100) {
			if (this.loggingEnabled) {
				this.log(`  [Buffer cleared - too long]: "${this.buffer}"`)
			}
			result = this.buffer + result
			this.buffer = ''
		}
		
		return result
	}
	
	/**
	 * Get a safe preview of text for logging
	 */
	private getSafePreview(text: string, maxLength: number): string {
		let preview = text
			.slice(0, maxLength)
			.replace(/\x1b/g, "ESC")
			.replace(/\n/g, "\\n")
			.replace(/\r/g, "\\r")
			.replace(/\t/g, "\\t")
		
		if (text.length > maxLength) {
			preview += "..."
		}
		
		return preview
	}
	
	/**
	 * Write to log file
	 */
	private log(message: string): void {
		if (this.logStream && !this.logStream.destroyed) {
			this.logStream.write(message + '\n')
		}
	}
	
	/**
	 * Enable or disable the processor
	 */
	public setEnabled(enabled: boolean): void {
		this.enabled = enabled
		this.log(`[LaTeX Processor] ${enabled ? "Enabled" : "Disabled"}`)
	}
	
	/**
	 * Get the LaTeX hashmap for external access (e.g., overlay renderer)
	 */
	public getLatexMap(): LatexHashMap {
		return this.latexMap
	}
	
	/**
	 * Get terminal cell dimensions using public API
	 */
	private getCellDimensions(): { width: number, height: number } {
		// Use public API to calculate cell dimensions
		const termElement = this.terminal.element
		if (!termElement) {
			console.warn('[LaTerM] Terminal element not available')
			return { width: 8, height: 16 } // Fallback values
		}
		
		// Get the viewport element which contains the actual terminal content
		const viewport = termElement.querySelector('.xterm-viewport') as HTMLElement
		const screen = termElement.querySelector('.xterm-screen') as HTMLElement
		
		// Use the screen element for dimensions as it represents the actual character grid
		const element = screen || viewport || termElement
		
		// Calculate cell dimensions from terminal grid
		// Use clientWidth/Height to exclude scrollbars
		const width = element.clientWidth / this.terminal.cols
		const height = element.clientHeight / this.terminal.rows
		
		console.log('[LaTerM] LaTeX Processor cell dimensions:', {
			elementWidth: element.clientWidth,
			elementHeight: element.clientHeight,
			cols: this.terminal.cols,
			rows: this.terminal.rows,
			calculatedCellWidth: width,
			calculatedCellHeight: height
		})
		
		return { width, height }
	}
	
	/**
	 * Get processor statistics
	 */
	public getStats(): void {
		this.log(`\n[LaTeX Processor] Session statistics:`)
		this.log(`  Process count: ${this.processCount}`)
		this.log(`  Current buffer: "${this.buffer}"`)
		this.log(`  HashMap: ${JSON.stringify(this.latexMap.getStats())}`)
		this.log(`  In alternate screen: ${this.inAlternateScreen}`)
	}
	
	/**
	 * Clean up resources
	 */
	public dispose(): void {
		this.log(`\n[LaTeX Processor] Disposing...`)
		this.getStats()
		this.log(`[LaTeX Processor] Session ended at ${new Date().toISOString()}`)
		
		// Restore original write function
		if (this.originalWrite) {
			this.terminal.write = this.originalWrite
		}
		
		// Clear the hashmap
		this.latexMap.clear()
		
		// Close log stream
		if (this.logStream && !this.logStream.destroyed) {
			this.logStream.end()
		}
	}
}