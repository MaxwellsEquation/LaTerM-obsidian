import type { Terminal } from "@xterm/xterm"
import * as fs from "fs"
import * as path from "path"

/**
 * TerminalWriteLogger - Logs data going to terminal.write() for debugging
 * Only captures data that will actually be displayed (not all PTY traffic)
 */
export class TerminalWriteLogger {
	private terminal: Terminal
	private loggingEnabled: boolean
	private enabled: boolean = true
	private sessionStartTime: number
	private writeCount: number = 0
	private totalBytes: number = 0
	private logFilePath: string = ""
	private logStream: fs.WriteStream | null = null
	private originalWrite: (data: string | Uint8Array, callback?: () => void) => void
	
	constructor(terminal: Terminal, loggingEnabled: boolean, vaultPath: string) {
		this.terminal = terminal
		this.loggingEnabled = loggingEnabled
		this.sessionStartTime = Date.now()
		
		// Store original write function BEFORE any modifications
		this.originalWrite = terminal.write.bind(terminal)
		
		// Always hook terminal.write (for future LaTeX processing)
		// Even if logging is disabled, we need the hook in place
		this.hookTerminalWrite()
		
		// Only set up logging file if enabled
		if (!loggingEnabled) {
			return
		}
		
		// Create log directory in vault's plugin folder
		const logDir = path.join(vaultPath, '.obsidian', 'plugins', 'laterm', 'logs')
		
		// Ensure log directory exists
		try {
			if (!fs.existsSync(logDir)) {
				fs.mkdirSync(logDir, { recursive: true })
			}
			
			const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
			this.logFilePath = path.join(logDir, `terminal-write-${timestamp}.log`)
			
			this.logStream = fs.createWriteStream(this.logFilePath, { flags: 'a' })
			this.log(`[Terminal Write Logger] Created at ${new Date().toISOString()}`)
			this.log(`[Terminal Write Logger] Terminal dimensions: ${terminal.cols}x${terminal.rows}`)
			this.log(`[Terminal Write Logger] Log file: ${this.logFilePath}`)
			
			// Log to console once so user knows where to find logs
			console.log(`[LaTerM] Terminal write logs: ${this.logFilePath}`)
		} catch (error) {
			console.error(`[LaTerM] Failed to create log file: ${error}`)
		}
	}
	
	/**
	 * Hook into terminal.write to log all display data
	 */
	private hookTerminalWrite(): void {
		// terminal.write can be called with (data) or (data, callback)
		this.terminal.write = (data: string | Uint8Array, callback?: () => void) => {
			// Process and log the data
			if (this.enabled && this.loggingEnabled) {
				if (typeof data === 'string') {
					this.logWrite(data)
				} else {
					this.logWrite(`[Binary data: ${data.length} bytes]`)
				}
			}
			
			// Call original write with both parameters
			// The callback is important for async operations
			return this.originalWrite(data, callback)
		}
	}
	
	/**
	 * Write to log file
	 */
	private log(message: string): void {
		if (!this.loggingEnabled) return
		if (this.logStream && !this.logStream.destroyed) {
			this.logStream.write(message + '\n')
		}
	}
	
	/**
	 * Log data being written to terminal
	 */
	private logWrite(data: string): void {
		this.writeCount++
		this.totalBytes += data.length
		
		// Build compact single-line summary
		const parts: string[] = []
		parts.push(`[#${this.writeCount}] ${data.length}B`)
		
		// Add ANSI sequence summary if present
		const ansiSummary = this.getAnsiSummary(data)
		if (ansiSummary) parts.push(ansiSummary)
		
		// Add control character summary if present  
		const controlSummary = this.getControlSummary(data)
		if (controlSummary) parts.push(controlSummary)
		
		// Add LaTeX pattern summary if present
		const latexSummary = this.getLatexSummary(data)
		if (latexSummary) parts.push(latexSummary)
		
		// Log everything on one line
		this.log(parts.join(' | '))
		
		// Show full data if LaTeX is detected, otherwise show preview
		if (latexSummary) {
			// LaTeX detected - show full data without truncation
			const fullData = this.getSafePreview(data, data.length)
			this.log(`  > [LATEX DATA] ${fullData}`)
		} else if (data.length > 0 && !data.match(/^[\x00-\x1F\x7F]+$/)) {
			// No LaTeX - show normal preview
			const preview = this.getSafePreview(data, 100)
			if (preview.length > 0 && preview !== "ESC[" && preview !== "\\n" && preview !== "\\r\\n") {
				this.log(`  > ${preview}`)
			}
		}
	}
	
	/**
	 * Get summary of ANSI sequences (returns null if none found)
	 */
	private getAnsiSummary(data: string): string | null {
		const sequences = {
			"CLR": /\x1b\[2J/g,
			"RST": /\x1b\[0m/g,
			"ALT+": /\x1b\[\?1049h/g,
			"ALT-": /\x1b\[\?1049l/g,
			"MOV": /\x1b\[\d+;\d+H/g,
			"COL": /\x1b\[\d+m/g,
			"SAV": /\x1b\[s/g,
			"RES": /\x1b\[u/g,
		}
		
		const found: string[] = []
		for (const [name, regex] of Object.entries(sequences)) {
			const matches = data.match(regex)
			if (matches && matches.length > 0) {
				found.push(`${name}:${matches.length}`)
			}
		}
		
		return found.length > 0 ? `ANSI[${found.join(' ')}]` : null
	}
	
	/**
	 * Get summary of LaTeX patterns (returns null if none found)
	 */
	private getLatexSummary(data: string): string | null {
		const patterns = [
			{ name: "$", regex: /\$[^$\n]+\$/g },
			{ name: "$$", regex: /\$\$[^$]+\$\$/g },
			{ name: "frac", regex: /\\frac\{[^}]*\}\{[^}]*\}/g },
			{ name: "vec", regex: /\\vec\{[^}]*\}/g },
			{ name: "nabla", regex: /\\nabla/g },
			{ name: "partial", regex: /\\partial/g },
			{ name: "Box", regex: /\\Box/g },
			{ name: "cdot", regex: /\\cdot/g },
			{ name: "times", regex: /\\times/g },
			{ name: "int", regex: /\\int/g },
			{ name: "sum", regex: /\\sum/g },
			{ name: "sqrt", regex: /\\sqrt(\[[^\]]*\])?\{[^}]*\}/g },
			{ name: "greek", regex: /\\(alpha|beta|gamma|delta|epsilon|theta|lambda|mu|nu|pi|rho|sigma|phi|psi|omega|Gamma|Delta|Theta|Lambda|Pi|Sigma|Phi|Psi|Omega)/g },
			{ name: "sub/sup", regex: /[_^]\{[^}]+\}|[_^][a-zA-Z0-9]/g },
			{ name: "lr", regex: /\\(left|right)[\[\](){}|]/g },
			{ name: "env", regex: /\\begin\{[^}]+\}/g },
		]
		
		const found: string[] = []
		for (const pattern of patterns) {
			const matches = data.match(pattern.regex)
			if (matches && matches.length > 0) {
				found.push(`${pattern.name}:${matches.length}`)
			}
		}
		
		return found.length > 0 ? `LaTeX[${found.join(' ')}]` : null
	}
	
	/**
	 * Get summary of control characters (returns null if none found)
	 */
	private getControlSummary(data: string): string | null {
		const controlChars = data.match(/[\x00-\x1F\x7F]/g)
		if (!controlChars || controlChars.length === 0) return null
		
		const counts = new Map<string, number>()
		for (const char of controlChars) {
			const name = this.getControlCharName(char.charCodeAt(0))
			counts.set(name, (counts.get(name) || 0) + 1)
		}
		
		const summary = Array.from(counts.entries())
			.map(([name, count]) => `${name}:${count}`)
			.join(' ')
		
		return `CTRL[${summary}]`
	}
	
	/**
	 * Get a safe preview of data for logging
	 */
	private getSafePreview(data: string, maxLength: number): string {
		// Replace control characters with visible representations
		let preview = data
			.slice(0, maxLength)
			.replace(/\x1b/g, "ESC")
			.replace(/\n/g, "\\n")
			.replace(/\r/g, "\\r")
			.replace(/\t/g, "\\t")
		
		if (data.length > maxLength && maxLength !== data.length) {
			preview += "..."
		}
		
		return preview
	}
	
	/**
	 * Get name of control character
	 */
	private getControlCharName(code: number): string {
		const names: Record<number, string> = {
			0x00: 'NUL', 0x01: 'SOH', 0x02: 'STX', 0x03: 'ETX',
			0x04: 'EOT', 0x05: 'ENQ', 0x06: 'ACK', 0x07: 'BEL',
			0x08: 'BS',  0x09: 'TAB', 0x0A: 'LF',  0x0B: 'VT',
			0x0C: 'FF',  0x0D: 'CR',  0x0E: 'SO',  0x0F: 'SI',
			0x10: 'DLE', 0x11: 'DC1', 0x12: 'DC2', 0x13: 'DC3',
			0x14: 'DC4', 0x15: 'NAK', 0x16: 'SYN', 0x17: 'ETB',
			0x18: 'CAN', 0x19: 'EM',  0x1A: 'SUB', 0x1B: 'ESC',
			0x1C: 'FS',  0x1D: 'GS',  0x1E: 'RS',  0x1F: 'US',
			0x7F: 'DEL'
		}
		return names[code] || 'UNK'
	}
	
	/**
	 * Enable or disable the logger
	 */
	public setEnabled(enabled: boolean): void {
		this.enabled = enabled
		this.log(`[Terminal Write Logger] ${enabled ? "Enabled" : "Disabled"}`)
	}
	
	/**
	 * Get statistics about the session
	 */
	public getStats(): void {
		const elapsed = Date.now() - this.sessionStartTime
		this.log(`\n[Terminal Write Logger] Session statistics:`)
		this.log(`  Duration: ${(elapsed / 1000).toFixed(1)}s`)
		this.log(`  Write calls: ${this.writeCount}`)
		this.log(`  Total bytes: ${this.totalBytes}`)
		if (this.writeCount > 0) {
			this.log(`  Average write size: ${(this.totalBytes / this.writeCount).toFixed(1)} bytes`)
			this.log(`  Writes per second: ${(this.writeCount / (elapsed / 1000)).toFixed(2)}`)
			this.log(`  Bytes per second: ${(this.totalBytes / (elapsed / 1000)).toFixed(0)}`)
		}
		this.log(`  Final terminal size: ${this.terminal.cols}x${this.terminal.rows}`)
	}
	
	/**
	 * Clean up resources
	 */
	public dispose(): void {
		this.log(`\n[Terminal Write Logger] Disposing...`)
		this.getStats()
		this.log(`[Terminal Write Logger] Session ended at ${new Date().toISOString()}`)
		
		// Restore original write function
		if (this.originalWrite) {
			this.terminal.write = this.originalWrite
		}
		
		// Close the log stream
		if (this.logStream && !this.logStream.destroyed) {
			this.logStream.end()
		}
	}
}