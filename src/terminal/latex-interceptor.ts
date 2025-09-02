import type { Terminal } from "@xterm/xterm"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"

/**
 * LatexInterceptor - Intercepts PTY data for LaTeX rendering
 * Currently a passthrough with detailed logging for debugging
 */
export class LatexInterceptor {
	private terminal: Terminal
	private enabled: boolean = true
	private sessionStartTime: number
	private dataCount: number = 0
	private totalBytes: number = 0
	private logFilePath: string
	private logStream: fs.WriteStream | null = null
	
	constructor(terminal: Terminal) {
		this.terminal = terminal
		this.sessionStartTime = Date.now()
		
		// Create log file in system temp directory
		const tmpDir = os.tmpdir()
		const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
		this.logFilePath = path.join(tmpDir, `laterm-interceptor-${timestamp}.log`)
		
		try {
			this.logStream = fs.createWriteStream(this.logFilePath, { flags: 'a' })
			this.log(`[LatexInterceptor] Created at ${new Date().toISOString()}`)
			this.log(`[LatexInterceptor] Terminal dimensions: ${terminal.cols}x${terminal.rows}`)
			this.log(`[LatexInterceptor] Log file: ${this.logFilePath}`)
			
			// Also log to console once so user knows where to find logs
			console.log(`[LaTerM] LaTeX interceptor logs: ${this.logFilePath}`)
		} catch (error) {
			console.error(`[LaTerM] Failed to create log file: ${error}`)
		}
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
	 * Process data from PTY before it reaches the terminal
	 * @param data - Raw data from PTY
	 * @returns Modified data to send to terminal
	 */
	public process(data: string): string {
		if (!this.enabled) {
			return data
		}
		
		this.dataCount++
		this.totalBytes += data.length
		
		// Log basic info
		this.log(`[LatexInterceptor] Data packet #${this.dataCount}`)
		this.log(`  Length: ${data.length} bytes`)
		this.log(`  Total session bytes: ${this.totalBytes}`)
		
		// Check for special sequences
		this.logSpecialSequences(data)
		
		// Check for potential LaTeX patterns (but don't modify yet)
		this.detectLatexPatterns(data)
		
		// Log first 100 chars of data (safely)
		const preview = this.getSafePreview(data, 100)
		this.log(`  Preview: ${preview}`)
		
		// For now, just pass through unchanged
		return data
	}
	
	/**
	 * Log any special ANSI sequences detected
	 */
	private logSpecialSequences(data: string): void {
		const sequences = {
			"Clear screen": /\x1b\[2J/,
			"Reset": /\x1b\[0m/,
			"Alternate buffer ON": /\x1b\[\?1049h/,
			"Alternate buffer OFF": /\x1b\[\?1049l/,
			"Cursor movement": /\x1b\[\d+;\d+H/,
			"Color change": /\x1b\[\d+m/,
			"Save cursor": /\x1b\[s/,
			"Restore cursor": /\x1b\[u/,
		}
		
		const detected: string[] = []
		for (const [name, regex] of Object.entries(sequences)) {
			if (regex.test(data)) {
				detected.push(name)
			}
		}
		
		if (detected.length > 0) {
			this.log(`  ANSI sequences detected: ${detected.join(", ")}`)
		}
	}
	
	/**
	 * Detect potential LaTeX patterns (logging only, no modification)
	 */
	private detectLatexPatterns(data: string): void {
		const patterns = [
			{ name: "Inline math", regex: /\$[^$\n]+\$/ },
			{ name: "Display math", regex: /\$\$[^$]+\$\$/ },
			{ name: "LaTeX brackets", regex: /\\\[.+?\\\]/ },
			{ name: "LaTeX parens", regex: /\\\(.+?\\\)/ },
			{ name: "Begin/end", regex: /\\begin\{.+?\}/ },
		]
		
		const detected: string[] = []
		for (const pattern of patterns) {
			if (pattern.regex.test(data)) {
				detected.push(pattern.name)
			}
		}
		
		if (detected.length > 0) {
			this.log(`  LaTeX patterns detected: ${detected.join(", ")}`)
		}
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
		
		if (data.length > maxLength) {
			preview += "..."
		}
		
		return preview
	}
	
	/**
	 * Enable or disable the interceptor
	 */
	public setEnabled(enabled: boolean): void {
		this.enabled = enabled
		this.log(`[LatexInterceptor] ${enabled ? "Enabled" : "Disabled"}`)
	}
	
	/**
	 * Get statistics about the session
	 */
	public getStats(): void {
		const elapsed = Date.now() - this.sessionStartTime
		this.log(`[LatexInterceptor] Session statistics:`)
		this.log(`  Duration: ${(elapsed / 1000).toFixed(1)}s`)
		this.log(`  Data packets: ${this.dataCount}`)
		this.log(`  Total bytes: ${this.totalBytes}`)
		if (this.dataCount > 0) {
			this.log(`  Average packet size: ${(this.totalBytes / this.dataCount).toFixed(1)} bytes`)
		}
	}
	
	/**
	 * Clean up resources
	 */
	public dispose(): void {
		this.log(`[LatexInterceptor] Disposing...`)
		this.getStats()
		
		// Close the log stream
		if (this.logStream && !this.logStream.destroyed) {
			this.logStream.end()
		}
	}
}