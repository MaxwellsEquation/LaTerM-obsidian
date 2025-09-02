/**
 * LatexHashMap - Manages hash generation and LaTeX expression storage
 * Uses self-identifying placeholders with «evm[hash]» format
 */

export interface LatexEntry {
	latex: string           // Original LaTeX expression
	displayWidth: number    // Calculated width in terminal cells
	displayHeight: number   // Calculated height in terminal lines (usually 1)
}

export class LatexHashMap {
	private map: Map<string, LatexEntry> = new Map()
	// Most terminals have scrollback of 1000-10000 lines
	// With average ~5 LaTeX expressions per screen, 5000 should cover even heavy usage
	private maxSize: number = 5000
	
	/**
	 * Generate a unique 5-character hash for a LaTeX expression
	 * Format: [a-f0-9]{5}
	 */
	generateHash(latex: string): string {
		// Deterministic hash - same LaTeX always gets same hash
		let hash = 0
		for (let i = 0; i < latex.length; i++) {
			const char = latex.charCodeAt(i)
			hash = ((hash << 5) - hash) + char
			hash = hash & hash // Convert to 32-bit integer
		}
		
		// Convert to hex and take first 5 chars
		// No counter - purely based on content
		const uniqueHash = Math.abs(hash).toString(16).substring(0, 5).padStart(5, '0')
		
		return uniqueHash
	}
	
	/**
	 * Format a placeholder with «evm» prefix and spacing
	 * Example: «evma7b3c»    (with spaces to fill width)
	 */
	formatPlaceholder(hash: string, width: number): string {
		const marker = `«evm${hash}»`
		const spaces = ' '.repeat(Math.max(0, width - marker.length))
		return marker + spaces
	}
	
	/**
	 * Extract hash from a placeholder marker
	 * Returns null if not a valid marker
	 */
	extractHash(text: string, position: number): string | null {
		// Look for «evm[hash]» pattern at position
		const markerRegex = /«evm([a-f0-9]{5})»/
		const substring = text.substring(position, position + 11) // «evm12345»
		const match = substring.match(markerRegex)
		return match?.[1] ?? null
	}
	
	/**
	 * Store a LaTeX expression with its hash
	 * Automatically evicts oldest entry if at max size
	 */
	set(hash: string, entry: LatexEntry): void {
		// If at max size, delete oldest (first) entry
		if (this.map.size >= this.maxSize) {
			const firstKey = this.map.keys().next().value
			if (firstKey) this.map.delete(firstKey)
		}
		this.map.set(hash, entry)
	}
	
	/**
	 * Get a LaTeX expression by its hash
	 */
	get(hash: string): LatexEntry | undefined {
		return this.map.get(hash)
	}
	
	/**
	 * Check if a hash exists
	 */
	has(hash: string): boolean {
		return this.map.has(hash)
	}
	
	/**
	 * Delete an entry by hash
	 */
	delete(hash: string): boolean {
		return this.map.delete(hash)
	}
	
	/**
	 * Get the size of the map
	 */
	get size(): number {
		return this.map.size
	}
	
	/**
	 * Find all hash markers in a line of text
	 * Returns array of {hash, column, width}
	 */
	findHashMarkers(text: string): Array<{hash: string, column: number, width: number}> {
		const markers: Array<{hash: string, column: number, width: number}> = []
		const regex = /«evm([a-f0-9]{5})»(\s*)/g
		let match
		
		while ((match = regex.exec(text)) !== null) {
			const hash = match[1]
			const totalWidth = match[0].length // Include marker and spaces
			
			if (hash && this.has(hash)) {
				markers.push({
					hash: hash,
					column: match.index,
					width: totalWidth
				})
			}
		}
		
		return markers
	}
	
	
	/**
	 * Calculate display dimensions for a LaTeX expression
	 * Returns both width and height estimates
	 */
	static calculateDisplayDimensions(latex: string): { width: number, height: number } {
		// Base width estimate
		let width = Math.ceil(latex.length * 0.6)
		let height = 1  // Default to single line height
		
		// Adjust for common patterns
		if (latex.includes('\\frac')) {
			width = Math.max(width, 8)
			height = 1  // Keep fractions at 1 line for now
		}
		if (latex.includes('\\int') || latex.includes('\\sum')) {
			width = Math.max(width, 6)
			height = 1  // Integrals/sums kept at 1 line
		}
		if (latex.includes('_{') || latex.includes('^{')) {
			width += 2
		}
		
		// Multi-line structures (matrices, cases, etc.)
		if (latex.includes('\\begin{') && latex.includes('matrix')) {
			// Count rows in matrix (rough estimate)
			const rows = (latex.match(/\\\\/g) || []).length + 1
			height = 1  // Still cap at 1 for now to avoid overlapping
			width = Math.max(width, 10 * Math.ceil(rows / 2))
		}
		
		// Minimum width for «evm12345» marker (10 chars)
		width = Math.max(width, 10)
		
		// Cap at reasonable maximum
		width = Math.min(width, 50)
		height = Math.min(height, 1)  // Force single line for v1
		
		return { width, height }
	}
	
	/**
	 * Debug: Get statistics about the map
	 */
	getStats(): {
		totalEntries: number
		maxSize: number
		percentFull: number
	} {
		return {
			totalEntries: this.map.size,
			maxSize: this.maxSize,
			percentFull: Math.round((this.map.size / this.maxSize) * 100)
		}
	}
	
	/**
	 * Clear all entries
	 */
	clear(): void {
		this.map.clear()
	}
}