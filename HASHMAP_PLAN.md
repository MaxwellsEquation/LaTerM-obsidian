# LaTeX Hashmap Rendering Plan

## Core Architecture

### The Self-Identifying Placeholder Strategy

When LaTeX is detected in `terminal.write()` data, we:
1. Generate a unique hash for the LaTeX expression
2. Calculate the display width needed for the rendered LaTeX
3. Replace the LaTeX with: `«hash»spaces` (e.g., `«a7b3c»     `)
4. Store the hash → LaTeX mapping
5. Let the modified text flow into the terminal buffer naturally

The key insight: **The buffer itself contains the information about what LaTeX belongs where**, making our system resilient to scrolling, clearing, and buffer modifications.

## Hash Generation Strategy

```typescript
interface LatexEntry {
  latex: string           // Original LaTeX expression
  displayWidth: number    // Calculated width in terminal cells
  timestamp: number       // For cleanup of old entries
  renderCount: number     // Times we've rendered this
}

class LatexHashMap {
  private map: Map<string, LatexEntry> = new Map()
  private counter: number = 0
  
  generateHash(latex: string): string {
    // Use 5-char hash with counter to prevent collisions
    // Format: «[a-f0-9]{5}»
    const baseHash = simpleHash(latex).substring(0, 4)
    const uniqueHash = baseHash + (this.counter++ % 16).toString(16)
    return uniqueHash
  }
  
  // Prefix with uncommon Unicode to avoid false matches
  // «evm» are rare in terminal output
  formatPlaceholder(hash: string, width: number): string {
    const marker = `«evm${hash}»`
    const spaces = ' '.repeat(Math.max(0, width - marker.length))
    return marker + spaces
  }
}
```

## Terminal Hooks

### 1. terminal.write() - Primary Interception Point

```typescript
class LatexProcessor {
  private buffer: string = ''  // For incomplete LaTeX at chunk boundaries
  private latexMap: LatexHashMap
  
  hookTerminalWrite(terminal: Terminal) {
    const originalWrite = terminal.write.bind(terminal)
    
    terminal.write = (data: string | Uint8Array, callback?: () => void) => {
      if (typeof data === 'string') {
        data = this.processLatex(data)
      }
      return originalWrite(data, callback)
    }
  }
  
  processLatex(text: string): string {
    // Combine with buffer for incomplete expressions
    const combined = this.buffer + text
    this.buffer = ''
    
    // Process complete LaTeX expressions
    const processed = combined.replace(
      /\$([^$\n]+?)\$/g,  // Inline LaTeX
      (match, latex) => {
        const hash = this.latexMap.generateHash(latex)
        const width = this.calculateWidth(latex)
        
        this.latexMap.set(hash, {
          latex,
          displayWidth: width,
          timestamp: Date.now(),
          renderCount: 0
        })
        
        return this.latexMap.formatPlaceholder(hash, width)
      }
    )
    
    // Check for incomplete LaTeX at end
    const lastDollar = processed.lastIndexOf('$')
    if (lastDollar > processed.lastIndexOf('\n')) {
      // Might be incomplete, buffer it
      this.buffer = processed.substring(lastDollar)
      return processed.substring(0, lastDollar)
    }
    
    return processed
  }
}
```

### 2. terminal.onRender() - Viewport Updates

```typescript
hookRenderEvent(terminal: Terminal) {
  terminal.onRender(() => {
    this.updateVisibleOverlays(terminal)
  })
}

updateVisibleOverlays(terminal: Terminal) {
  // Clear existing overlays
  this.overlayManager.clearAll()
  
  const viewport = terminal.buffer.active.viewportY
  
  for (let row = 0; row < terminal.rows; row++) {
    const line = terminal.buffer.active.getLine(viewport + row)
    if (!line) continue
    
    const text = line.translateToString()
    
    // Find all hash markers in this line
    const hashRegex = /«([a-f0-9]{5})»/g
    let match
    
    while ((match = hashRegex.exec(text)) !== null) {
      const hash = match[1]
      const entry = this.latexMap.get(hash)
      
      if (entry) {
        // Calculate pixel position
        const col = match.index
        const pixelPos = this.getPixelPosition(terminal, row, col)
        
        // Create overlay at this position
        this.overlayManager.createOverlay({
          latex: entry.latex,
          top: pixelPos.top,
          left: pixelPos.left,
          width: entry.displayWidth
        })
        
        entry.renderCount++
      }
    }
  }
}
```

### 3. terminal.onScroll() - Handle Scrolling

```typescript
hookScrollEvent(terminal: Terminal) {
  // Scrolling changes the viewport, triggering re-render
  terminal.onScroll(() => {
    // Debounce to avoid excessive updates during smooth scrolling
    clearTimeout(this.scrollTimer)
    this.scrollTimer = setTimeout(() => {
      this.updateVisibleOverlays(terminal)
    }, 50)
  })
}
```

### 4. terminal.onResize() - Terminal Dimension Changes

```typescript
hookResizeEvent(terminal: Terminal) {
  terminal.onResize(() => {
    // Recalculate all overlay positions
    this.updateVisibleOverlays(terminal)
    
    // Note: Text reflow might break LaTeX across lines
    // Our hash markers will reflow with the text
  })
}
```

### 5. Buffer Change Events - Alternate Screens

```typescript
hookBufferEvents(terminal: Terminal) {
  // No direct API, but we can detect alternate buffer by watching for specific sequences
  const originalWrite = terminal.write.bind(terminal)
  
  terminal.write = (data: string | Uint8Array, callback?: () => void) => {
    if (typeof data === 'string') {
      // Detect alternate screen entry/exit
      if (data.includes('\x1b[?1049h')) {
        // Entering alternate screen (vim, less, etc.)
        this.overlayManager.hideAll()
        this.inAlternateScreen = true
      } else if (data.includes('\x1b[?1049l')) {
        // Exiting alternate screen
        this.inAlternateScreen = false
        this.updateVisibleOverlays(terminal)
      }
      
      // Process LaTeX only in normal screen
      if (!this.inAlternateScreen) {
        data = this.processLatex(data)
      }
    }
    
    return originalWrite(data, callback)
  }
}
```

## Edge Cases & Solutions

### 1. Hash Collisions
- Use 5-character hash + counter: `«a7b3c»`
- Probability of collision negligible for typical usage
- If collision detected, append incremental suffix

### 2. Partial LaTeX at Write Boundaries
```typescript
// Example: Two writes
write("Here is $\\fra")
write("c{1}{2}$ done")

// Solution: Buffer incomplete expressions
if (text.endsWith('$') || hasUnmatchedDollar(text)) {
  this.buffer = extractIncompleteLatex(text)
}
```

### 3. LaTeX Spanning Multiple Lines
```typescript
// Initially: Don't support
// LaTeX with newlines is rejected
if (latex.includes('\n')) {
  return originalText  // Don't process
}

// Future: Could support with multi-line placeholders
```

### 4. Very Long LaTeX Expressions
```typescript
calculateWidth(latex: string): number {
  const estimated = estimateRenderedWidth(latex)
  const terminalWidth = terminal.cols
  
  // Cap at 90% of terminal width
  return Math.min(estimated, Math.floor(terminalWidth * 0.9))
}
```

### 5. Hash Pattern in Normal Text
- Using `«»` delimiters makes false matches extremely unlikely
- Could add validation: check if surrounding text matches placeholder pattern

### 6. Buffer Scrollback Limit
```typescript
cleanupOldEntries() {
  const now = Date.now()
  const maxAge = 30 * 60 * 1000  // 30 minutes
  
  for (const [hash, entry] of this.latexMap.entries()) {
    if (now - entry.timestamp > maxAge && entry.renderCount === 0) {
      this.latexMap.delete(hash)
    }
  }
}
```

### 7. Clear Screen Commands
```typescript
// Clear screen doesn't affect our system!
// - Hashes in buffer are cleared with the text
// - Next render finds no hashes, shows no overlays
// - Old map entries cleaned up after timeout
```

### 8. Line Overwriting (Progress Bars)
```typescript
// Example: Progress bar overwrites same line
write("Progress: 50%\r")
write("Progress: 100%\r")

// Our hashes are overwritten naturally
// No special handling needed - overlays update on next render
```

### 9. Copy/Paste with Hashes
```typescript
// User copies text containing «a7b3c»     
// When pasted, we'll see the hash and try to render it
// Solution: Validate hash exists in map before rendering
if (this.latexMap.has(hash)) {
  // Valid hash, render overlay
} else {
  // Unknown hash, ignore (probably pasted)
}
```

## Scrolling Behavior Explained

The beauty of the hashmap approach under scrolling:

1. **User writes LaTeX** → We replace with `«hash»spaces` → Goes into buffer
2. **User scrolls down** → Hash scrolls out of viewport → No overlay needed
3. **User scrolls back up** → Hash comes into viewport → We detect it and create overlay
4. **User uses `cat` to dump file** → All LaTeX replaced with hashes → All stored in buffer
5. **User scrolls through output** → We only render overlays for visible hashes

**Key Properties:**
- **Stateless rendering**: Don't track positions, just scan visible buffer
- **Self-healing**: If anything goes wrong, next render fixes it
- **Memory efficient**: Only create overlays for visible content
- **Survives buffer operations**: Clear, alternate screens, overwrites all handled naturally

## Memory Management

```typescript
class LatexHashMap {
  private maxEntries = 1000
  private maxAge = 30 * 60 * 1000  // 30 minutes
  
  periodicCleanup() {
    // Run every 5 minutes
    setInterval(() => {
      // Remove old, unrendered entries
      this.cleanupOldEntries()
      
      // If still too many, remove least recently rendered
      if (this.map.size > this.maxEntries) {
        this.removeLeastRecentlyUsed()
      }
    }, 5 * 60 * 1000)
  }
}
```

## Implementation Phases

### Phase 1: Basic Implementation
- terminal.write() hook with LaTeX detection
- Simple hash generation
- Basic overlay creation
- Render event handling

### Phase 2: Robustness
- Buffering for incomplete LaTeX
- Alternate screen detection
- Resize handling
- Memory cleanup

### Phase 3: Optimization
- Debounced scroll handling
- Overlay pooling/reuse
- Smarter width calculation
- Performance profiling

### Phase 4: Enhanced Features
- Multi-line LaTeX support
- Display math (`$$...$$`) handling
- Custom delimiters support
- Copy/paste handling with original LaTeX recovery

## Success Metrics

The system is working correctly when:
1. LaTeX is replaced with hashes in the terminal buffer
2. Overlays appear at hash positions when visible
3. Scrolling maintains correct overlay positioning
4. vim/less don't show overlays in alternate screen
5. Clear commands remove overlays appropriately
6. Memory usage remains bounded
7. No performance degradation during normal terminal use