# LaTeX Terminal Integration Architecture

## Overview: terminal.write() Hook with HTML Overlays

We hook the `terminal.write()` function to intercept only data that will be displayed, replace LaTeX expressions with placeholders, and render KaTeX overlays on top.

## Core Architecture

### Data Flow
```
Shell Process
     ↓
PTY Output Stream
     ↓
pty.onData() → terminal.write()  ← WE HOOK HERE
                      ↓
              LaTeX Detection & Buffering
                      ↓
              Placeholder Generation
                      ↓
              originalWrite(modified_data)
                      ↓
              Terminal Grid Display
                      ↓
              KaTeX Overlay Positioning
                      ↓
              Final Visual Output
```

### Key Insight
- **No PTY interception needed** - We only process data that will actually be displayed
- **terminal.write()** is the single point where all display data flows through
- **Most PTY data never reaches terminal.write()** (control sequences, queries, etc.)
- HTML overlays positioned precisely over placeholder characters in the grid
- Terminal handles scrolling, selection, and reflow normally

## Implementation Strategy

### Phase 1: Intercept & Detect

```typescript
// File: src/terminal/latex-processor.ts
export class LatexProcessor {
    private buffer: string = "";
    private overlayManager: OverlayManager;
    private terminal: Terminal;
    
    constructor(terminal: Terminal, container: HTMLElement) {
        this.terminal = terminal;
        this.overlayManager = new OverlayManager(terminal, container);
    }
    
    processData(data: string): string {
        // Buffer data to handle streaming LaTeX
        this.buffer += data;
        
        // Check if we have complete LaTeX expressions
        const processed = this.detectAndReplaceLatex(this.buffer);
        
        if (processed.complete) {
            this.buffer = processed.remainder;
            return processed.output;
        }
        
        // If incomplete LaTeX, wait for more data
        if (this.hasIncompleteLatex(this.buffer)) {
            return ""; // Don't write anything yet
        }
        
        // No LaTeX, flush buffer
        const output = this.buffer;
        this.buffer = "";
        return output;
    }
}
```

### Phase 2: LaTeX Detection & Replacement

```typescript
interface LatexRegion {
    type: 'inline' | 'display';
    latex: string;
    startPos: number;
    endPos: number;
    placeholder: string;
    lineNumber?: number;
    columnStart?: number;
}

class LatexDetector {
    // Patterns for complete LaTeX expressions
    private patterns = [
        { regex: /\$\$((?:[^\$]|\\\$)+)\$\$/g, type: 'display' },
        { regex: /\$((?:[^\$]|\\\$)+)\$/g, type: 'inline' },
        { regex: /\\\[(.*?)\\\]/gs, type: 'display' },
        { regex: /\\\((.*?)\\\)/g, type: 'inline' },
        { regex: /\\begin\{equation\}(.*?)\\end\{equation\}/gs, type: 'display' },
        { regex: /\\begin\{align\}(.*?)\\end\{align\}/gs, type: 'display' }
    ];
    
    detectAndReplaceLatex(text: string): {
        output: string;
        regions: LatexRegion[];
        complete: boolean;
        remainder: string;
    } {
        const regions: LatexRegion[] = [];
        let output = text;
        let complete = true;
        
        // Check for incomplete LaTeX at end
        if (this.hasIncompleteLatexAtEnd(text)) {
            complete = false;
            // Return incomplete portion as remainder
            const splitPoint = this.findLastCompletePosition(text);
            return {
                output: this.processCompleteText(text.slice(0, splitPoint), regions),
                regions,
                complete: false,
                remainder: text.slice(splitPoint)
            };
        }
        
        // Process complete LaTeX expressions
        for (const pattern of this.patterns) {
            output = output.replace(pattern.regex, (match, latex, offset) => {
                const placeholder = this.generatePlaceholder(latex, pattern.type);
                
                regions.push({
                    type: pattern.type as 'inline' | 'display',
                    latex,
                    startPos: offset,
                    endPos: offset + match.length,
                    placeholder
                });
                
                return placeholder;
            });
        }
        
        return { output, regions, complete, remainder: "" };
    }
    
    generatePlaceholder(latex: string, type: string): string {
        if (type === 'inline') {
            // Estimate width for inline math
            const estimatedWidth = Math.min(latex.length / 2, 10);
            return '█'.repeat(Math.max(3, estimatedWidth));
        } else {
            // Multi-line placeholder for display math
            const lines = this.estimateLatexLines(latex);
            const width = 20; // Standard width for display math
            
            return lines.map(() => '░'.repeat(width)).join('\n');
        }
    }
    
    estimateLatexLines(latex: string): string[] {
        // Simple heuristic - can be improved
        if (latex.includes('\\begin{matrix}') || latex.includes('\\begin{bmatrix}')) {
            const rows = (latex.match(/\\\\/g) || []).length + 1;
            return Array(rows).fill('');
        }
        if (latex.includes('\\frac')) {
            return ['', '']; // Fractions need 2 lines minimum
        }
        return ['']; // Default single line
    }
}
```

### Phase 3: Overlay Management

```typescript
// File: src/terminal/overlay-manager.ts
export class OverlayManager {
    private overlays: Map<string, HTMLElement> = new Map();
    private terminal: Terminal;
    private container: HTMLElement;
    private overlayContainer: HTMLElement;
    
    constructor(terminal: Terminal, container: HTMLElement) {
        this.terminal = terminal;
        this.container = container;
        this.setupOverlayContainer();
        this.attachEventListeners();
    }
    
    private setupOverlayContainer() {
        this.overlayContainer = document.createElement('div');
        this.overlayContainer.className = 'latex-overlay-container';
        this.overlayContainer.style.cssText = `
            position: absolute;
            top: 0;
            left: 0;
            pointer-events: none;
            z-index: 10;
        `;
        this.container.appendChild(this.overlayContainer);
    }
    
    createOverlay(region: LatexRegion, bufferPosition: BufferPosition): void {
        const id = `latex-${Date.now()}-${Math.random()}`;
        const overlay = document.createElement('div');
        overlay.className = `latex-overlay latex-${region.type}`;
        overlay.dataset.latexSource = region.type === 'inline' 
            ? `$${region.latex}$` 
            : `$$${region.latex}$$`;
        
        // Render with KaTeX
        try {
            katex.render(region.latex, overlay, {
                displayMode: region.type === 'display',
                throwOnError: false,
                trust: true
            });
        } catch (e) {
            console.error('KaTeX render error:', e);
            overlay.textContent = region.placeholder;
            overlay.classList.add('latex-error');
        }
        
        // Position overlay
        this.positionOverlay(overlay, bufferPosition);
        
        // Store reference
        this.overlays.set(id, overlay);
        this.overlayContainer.appendChild(overlay);
        
        // Track for cleanup
        this.trackOverlayLifecycle(id, bufferPosition);
    }
    
    private positionOverlay(overlay: HTMLElement, position: BufferPosition) {
        // Get cell dimensions from terminal
        const cellWidth = (this.terminal as any).renderer.dimensions.actualCellWidth;
        const cellHeight = (this.terminal as any).renderer.dimensions.actualCellHeight;
        
        // Calculate pixel position
        const x = position.col * cellWidth;
        const y = (position.row - this.terminal.buffer.active.viewportY) * cellHeight;
        
        overlay.style.cssText += `
            position: absolute;
            left: ${x}px;
            top: ${y}px;
        `;
    }
    
    private attachEventListeners() {
        // Handle scrolling
        this.terminal.onScroll(() => {
            this.updateOverlayPositions();
        });
        
        // Handle resize
        this.terminal.onResize(() => {
            this.updateOverlayPositions();
        });
        
        // Handle buffer clear
        this.terminal.onData((data) => {
            if (data.includes('\x1b[2J') || data.includes('\x1b[3J')) {
                this.clearAllOverlays();
            }
        });
        
        // Handle line overwrites
        this.terminal.onRender((e) => {
            this.checkForOverwrites(e.start, e.end);
        });
    }
    
    private updateOverlayPositions() {
        for (const [id, overlay] of this.overlays) {
            const position = this.getStoredPosition(id);
            if (position) {
                this.positionOverlay(overlay, position);
            }
        }
    }
}
```

### Phase 4: Integration with Existing Terminal

```typescript
// File: src/terminal/pseudoterminal.ts (modified)
export class Pseudoterminal {
    private latexProcessor: LatexProcessor;
    private originalWrite: (data: string | Uint8Array) => void;
    
    constructor(/*...*/) {
        // ... existing constructor code ...
        
        // Initialize LaTeX processor
        this.latexProcessor = new LatexProcessor(this.terminal, this.container);
        
        // Hook terminal.write BEFORE any data flows
        this.hookTerminalWrite();
    }
    
    private hookTerminalWrite() {
        // Store original write function
        this.originalWrite = this.terminal.write.bind(this.terminal);
        
        // Override terminal.write
        this.terminal.write = (data: string | Uint8Array) => {
            if (typeof data === 'string') {
                // Process for LaTeX - only display-bound data reaches here
                const processed = this.latexProcessor.processData(data);
                this.originalWrite(processed);
            } else {
                // Binary data, pass through unchanged
                this.originalWrite(data);
            }
        };
    }
    
    // PTY connection remains unchanged - we don't touch it
    private setupPtyConnection() {
        // Standard PTY → terminal connection
        this.pty.onData((data: string) => {
            terminal.write(data); // Goes through our hook automatically
        });
        
        // No PTY interception needed!
    }
}
```

## Edge Cases & Solutions

### 1. Streaming LaTeX Input
**Problem**: LaTeX expressions split across multiple PTY packets
```
Packet 1: "The equation $$\\frac{1"
Packet 2: "}{2}$$ shows..."
```

**Solution**: Buffer incomplete LaTeX
```typescript
class StreamBuffer {
    private buffer: string = "";
    private timeout: NodeJS.Timeout;
    
    append(data: string): string | null {
        this.buffer += data;
        
        // Clear old timeout
        if (this.timeout) clearTimeout(this.timeout);
        
        // Check for complete LaTeX
        if (this.hasCompleteLatex()) {
            const result = this.buffer;
            this.buffer = "";
            return result;
        }
        
        // Set timeout to flush incomplete LaTeX
        this.timeout = setTimeout(() => {
            if (this.buffer) {
                this.flush();
            }
        }, 100); // 100ms timeout
        
        return null;
    }
}
```

### 2. Terminal Clear/Reset
**Problem**: Overlays remain after terminal clear
**Solution**: Listen for clear sequences
```typescript
terminal.onData((data) => {
    const clearPatterns = [
        '\x1b[2J',  // Clear screen
        '\x1b[3J',  // Clear scrollback
        '\x1b[H\x1b[2J', // Clear and home
        '\x1bc'      // Full reset
    ];
    
    if (clearPatterns.some(p => data.includes(p))) {
        overlayManager.clearAllOverlays();
    }
});
```

### 3. Line Overwrites (Progress bars, etc.)
**Problem**: Content overwrites LaTeX placeholder
**Solution**: Track line content state
```typescript
class LineTracker {
    private lines: Map<number, LineState> = new Map();
    
    trackWrite(row: number, col: number, text: string) {
        const state = this.lines.get(row) || new LineState();
        
        // Check if overwriting LaTeX region
        if (state.hasLatexAt(col, col + text.length)) {
            // Remove affected overlays
            this.removeOverlaysForRegion(row, col, text.length);
        }
        
        state.updateContent(col, text);
        this.lines.set(row, state);
    }
}
```

### 4. Scrollback Buffer
**Problem**: LaTeX in history needs rendering when scrolled into view
**Solution**: Scan visible buffer periodically
```typescript
class ScrollbackScanner {
    scanVisibleBuffer() {
        const viewport = terminal.buffer.active.viewportY;
        const rows = terminal.rows;
        
        for (let i = 0; i < rows; i++) {
            const line = terminal.buffer.active.getLine(viewport + i);
            if (line) {
                const text = line.translateToString();
                if (this.hasUnprocessedLatex(text)) {
                    this.processLineLatex(viewport + i, text);
                }
            }
        }
    }
}
```

### 5. Terminal Resize
**Problem**: Overlays misaligned after resize
**Solution**: Recalculate positions
```typescript
terminal.onResize((size) => {
    // Recalculate cell dimensions
    const newCellWidth = terminal.renderer.dimensions.actualCellWidth;
    const newCellHeight = terminal.renderer.dimensions.actualCellHeight;
    
    // Update all overlay positions
    overlayManager.recalculateAllPositions(newCellWidth, newCellHeight);
});
```

### 6. Copy/Paste
**Problem**: Copying rendered LaTeX should copy source
**Solution**: Custom selection handler
```typescript
document.addEventListener('copy', (e) => {
    const selection = window.getSelection();
    const range = selection.getRangeAt(0);
    
    // Check if selection includes LaTeX overlays
    const overlays = overlayContainer.querySelectorAll('.latex-overlay');
    let text = selection.toString();
    
    overlays.forEach(overlay => {
        if (range.intersectsNode(overlay)) {
            // Replace rendered content with source
            const source = overlay.dataset.latexSource;
            text = text.replace(overlay.textContent, source);
        }
    });
    
    e.clipboardData.setData('text/plain', text);
    e.preventDefault();
});
```

## CSS Styling

```css
.latex-overlay-container {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
    z-index: 10;
}

.latex-overlay {
    position: absolute;
    pointer-events: auto; /* Allow selection */
    background: var(--terminal-background);
    color: var(--terminal-foreground);
}

.latex-overlay.latex-inline {
    display: inline-block;
    vertical-align: middle;
    /* Ensure it aligns with terminal text baseline */
    transform: translateY(-0.1em);
}

.latex-overlay.latex-display {
    display: block;
    text-align: center;
    padding: 0.2em 0;
    /* Slightly different background for display math */
    background: color-mix(in srgb, var(--terminal-background) 95%, var(--terminal-foreground) 5%);
}

.latex-overlay.latex-error {
    color: var(--error-color);
    font-family: monospace;
    opacity: 0.7;
}

/* Ensure KaTeX uses terminal colors */
.latex-overlay .katex {
    color: inherit;
    font-size: 1em;
}

.latex-overlay .katex-display {
    margin: 0;
    padding: 0;
}
```

## File Changes Summary

### Files to Modify

| File | Changes | Purpose |
|------|---------|---------|
| `pseudoterminal.ts` | Add terminal.write() hook | Intercept display data only |
| `styles.css` | Add overlay styles | Visual appearance |

### Files to Create

| File | Purpose | Size |
|------|---------|------|
| `latex-processor.ts` | Main LaTeX detection and processing | ~300 lines |
| `overlay-manager.ts` | HTML overlay positioning and lifecycle | ~400 lines |
| `stream-buffer.ts` | Handle streaming LaTeX input | ~100 lines |
| `line-tracker.ts` | Track terminal line state | ~150 lines |

### Files to Remove

| File | Reason |
|------|--------|
| `latex-interceptor.ts` | No longer needed - was for PTY interception |

## Advantages of This Approach

1. **Minimal Changes** - Only hooks terminal.write(), no PTY modifications
2. **Efficiency** - Only processes data that will be displayed (not all PTY traffic)
3. **Preserves Terminal Features** - Scrolling, selection, reflow all work normally
4. **Multi-line Support** - Overlays can span multiple lines visually
5. **Performance** - Avoids processing control sequences, queries, and non-display data
6. **Clean Separation** - LaTeX rendering completely separate from PTY layer
7. **Maintainable** - Single interception point, clear data flow

## Testing Strategy

1. **Unit Tests**
   - LaTeX pattern detection
   - Placeholder generation
   - Buffer management

2. **Integration Tests**
   - PTY data flow
   - Overlay positioning
   - Event handling

3. **Edge Case Tests**
   - Streaming input
   - Terminal operations (clear, reset)
   - Scrolling and resize
   - Copy/paste

4. **Performance Tests**
   - Large LaTeX expressions
   - Rapid updates
   - Many overlays

## Implementation Timeline

1. **Week 1**: Core interception and detection
2. **Week 2**: Overlay rendering and positioning
3. **Week 3**: Edge case handling
4. **Week 4**: Polish and testing